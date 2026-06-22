import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { Semaphore } from '../../common/semaphore';
import { getAbortSignal } from '../../common/request-context';
import type { EmbedderProvider } from './embedder-provider.interface';

export interface OpenAIEmbedderConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
}

/**
 * OpenAI embedding provider — the historical path. text-embedding-3-*
 * with caller-specified dimensions. Identical-text → identical vector
 * (deterministic).
 *
 * Kept thin: cache, concurrency limiter, and provider-vs-provider
 * routing all live in EmbedderService so swapping to BGE-M3 doesn't
 * disturb the call sites.
 */
export class OpenAIEmbedderProvider implements EmbedderProvider {
  readonly providerId: string;
  private readonly logger = new Logger(OpenAIEmbedderProvider.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly limiter: Semaphore;

  constructor(cfg: OpenAIEmbedderConfig) {
    this.openai = new OpenAI({
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
    });
    this.model = cfg.model;
    this.dimensions = cfg.dimensions;
    this.providerId = `openai:${cfg.model}:${cfg.dimensions}`;
    this.limiter = new Semaphore(cfg.concurrency);
  }

  getDimensions(): number {
    return this.dimensions;
  }

  isReady(): boolean {
    return true;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedWithUsage(text)).vector;
  }

  /**
   * Single-string embed that also surfaces the API's token usage so the
   * gen-ai observability wrapper can populate `gen_ai.usage.input_tokens`.
   * The OpenAI /embeddings response reports `usage.total_tokens`; without
   * threading it back out, the embedding token counter stays pinned at 0.
   */
  async embedWithUsage(
    text: string,
  ): Promise<{ vector: number[]; usage?: { total_tokens?: number } }> {
    const trimmed = text.trim();
    if (!trimmed) return { vector: new Array(this.dimensions).fill(0) };
    return this.limiter.run(async () => {
      const res = await this.openai.embeddings.create(
        {
          model: this.model,
          input: trimmed,
          dimensions: this.dimensions,
        },
        { signal: getAbortSignal() },
      );
      return { vector: res.data[0].embedding, usage: res.usage };
    });
  }

  /**
   * Batched embedding. OpenAI's /embeddings endpoint accepts up to
   * 2048 inputs per call; we batch the user-supplied array into
   * <=512 chunks (the safer default that also keeps a single failed
   * call to a digestible blast radius). Empty / whitespace inputs
   * are short-circuited to the zero vector and never sent to the API.
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = new Array(texts.length);
    const indices: number[] = [];
    const inputs: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const trimmed = texts[i]?.trim() ?? '';
      if (!trimmed) {
        out[i] = new Array(this.dimensions).fill(0);
      } else {
        indices.push(i);
        inputs.push(trimmed);
      }
    }
    if (inputs.length === 0) return out;

    const CHUNK = 512;
    for (let start = 0; start < inputs.length; start += CHUNK) {
      const slice = inputs.slice(start, start + CHUNK);
      const sliceIdx = indices.slice(start, start + CHUNK);
      const res = await this.limiter.run(() =>
        this.openai.embeddings.create(
          {
            model: this.model,
            input: slice,
            dimensions: this.dimensions,
          },
          { signal: getAbortSignal() },
        ),
      );
      // Index by the API-provided `.index`, NOT array position. The
      // OpenAI contract guarantees the index field, not that data[] is
      // pre-sorted — positional assignment would map a vector to the
      // wrong text if the API ever reorders a batch.
      for (const d of res.data) {
        out[sliceIdx[d.index]] = d.embedding;
      }
    }
    return out;
  }
}
