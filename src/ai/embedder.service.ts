import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { LRUCache } from '../common/lru-cache';
import { Semaphore } from '../common/semaphore';

@Injectable()
export class EmbedderService {
  private readonly logger = new Logger(EmbedderService.name);
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly dimensions: number;
  // Identical text → identical embedding (deterministic for OpenAI's
  // text-embedding-3-* family). Cache by sha256(model:dim:text) so
  // re-extractions on near-duplicate input — same predicate+object
  // emitted by replay or retry — don't re-pay the OpenAI round trip.
  private readonly cache: LRUCache<string, number[]>;
  // Bound concurrent OpenAI calls below the per-key rate ceiling.
  // The OpenAI SDK's built-in retries handle 429s, but high-concurrency
  // bursts trip rate limits before retries exhaust their budget.
  private readonly limiter: Semaphore;

  constructor(private readonly configService: ConfigService) {
    const timeoutMs = parseInt(
      this.configService.get<string>('OPENAI_TIMEOUT_MS', '30000'),
      10,
    );
    const maxRetries = parseInt(
      this.configService.get<string>('OPENAI_MAX_RETRIES', '3'),
      10,
    );
    this.openai = new OpenAI({
      apiKey: this.configService.getOrThrow<string>('OPENAI_API_KEY'),
      timeout: timeoutMs,
      maxRetries,
    });
    this.model = this.configService.get<string>(
      'OPENAI_EMBEDDING_MODEL',
      'text-embedding-3-small',
    );
    this.dimensions = parseInt(
      this.configService.get<string>('OPENAI_EMBEDDING_DIMENSIONS', '1536'),
      10,
    );
    const cacheSize = parseInt(
      this.configService.get<string>('EMBEDDING_CACHE_SIZE', '2000'),
      10,
    );
    this.cache = new LRUCache<string, number[]>(cacheSize);
    const concurrency = parseInt(
      this.configService.get<string>('OPENAI_CONCURRENCY', '8'),
      10,
    );
    this.limiter = new Semaphore(concurrency);
  }

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) return new Array(this.dimensions).fill(0);

    const key = this.cacheKey(trimmed);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const vec = await this.limiter.run(async () => {
      const res = await this.openai.embeddings.create({
        model: this.model,
        input: trimmed,
        dimensions: this.dimensions,
      });
      return res.data[0].embedding;
    });
    this.cache.set(key, vec);
    return vec;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  /** Test/diagnostic surface — no business code should depend on cache shape. */
  cacheStats(): { size: number; inFlight: number; waiting: number } {
    return {
      size: this.cache.size,
      inFlight: this.limiter.inFlight(),
      waiting: this.limiter.pending(),
    };
  }

  private cacheKey(text: string): string {
    return createHash('sha256')
      .update(`${this.model}:${this.dimensions}:${text}`)
      .digest('hex');
  }
}
