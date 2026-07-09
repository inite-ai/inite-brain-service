import { Logger } from '@nestjs/common';

/**
 * Local cross-encoder reranker via `@xenova/transformers`
 * (`AutoModelForSequenceClassification`, default `Xenova/bge-reranker-base`).
 *
 * The no-Cohere-key fallback for the rerank stage: when `COHERE_API_KEY` is
 * absent but `SEARCH_CROSS_ENCODER_LOCAL=1`, this scores each (query, document)
 * pair with a joint encoder — real query×document attention, not pooled
 * embeddings — so self-hosters without a rerank vendor still get a cross-encoder
 * pass. Mirrors the BGE-M3 embedder's local-inference pattern
 * (src/ai/embedder/bge-m3-embedder.provider.ts).
 *
 * The model is lazy-loaded on first use (the ONNX weights are fetched/cached by
 * transformers.js); until warmup resolves `isReady()` is false and the caller
 * keeps the fusion order. A failed warmup latches `failed` so we don't retry the
 * download on every request.
 *
 * Inference runs in-thread. A single pair scores in ~5-20ms, and the whole
 * rerank sits under `SEARCH_STAGE_BUDGET_CROSS_ENCODER_MS`, so a wide window
 * stays bounded; hosting the model in a worker_thread (as the embedder does) is
 * a future optimization if the fallback sees heavy traffic.
 */

/** Minimal shape of the transformers.js pieces we use — avoids a hard type dep. */
interface Tokenizer {
  (
    query: string,
    opts: { text_pair: string; padding: boolean; truncation: boolean },
  ): Promise<unknown>;
}
interface SeqClassModel {
  (inputs: unknown): Promise<{ logits: { data: Float32Array | number[] } }>;
}

export interface LocalCrossEncoderConfig {
  modelId: string;
}

export class LocalCrossEncoderProvider {
  readonly modelId: string;
  private readonly logger = new Logger(LocalCrossEncoderProvider.name);
  private tokenizer: Tokenizer | null = null;
  private model: SeqClassModel | null = null;
  private warmupPromise: Promise<void> | null = null;
  private failed = false;

  constructor(cfg: LocalCrossEncoderConfig) {
    this.modelId = cfg.modelId;
  }

  isReady(): boolean {
    return this.tokenizer !== null && this.model !== null;
  }

  /** Load (or await the in-flight load of) the tokenizer + model. Idempotent;
   *  a failed load latches so we don't re-download on every call. */
  async warmup(): Promise<void> {
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      const t = (await import('@xenova/transformers')) as unknown as {
        AutoTokenizer: {
          from_pretrained: (id: string) => Promise<Tokenizer>;
        };
        AutoModelForSequenceClassification: {
          from_pretrained: (
            id: string,
            opts?: { quantized?: boolean },
          ) => Promise<SeqClassModel>;
        };
      };
      this.tokenizer = await t.AutoTokenizer.from_pretrained(this.modelId);
      this.model = await t.AutoModelForSequenceClassification.from_pretrained(
        this.modelId,
        { quantized: true },
      );
    })().catch((e) => {
      this.failed = true;
      this.tokenizer = null;
      this.model = null;
      this.logger.warn(
        `local cross-encoder warmup failed (${(e as Error).message}); rerank keeps fusion order`,
      );
    });
    return this.warmupPromise;
  }

  /**
   * Relevance score per document (higher = more relevant). Returns an empty
   * array on any failure so the caller falls back to the identity permutation.
   */
  async score(query: string, documents: string[]): Promise<number[]> {
    if (this.failed) return [];
    if (!this.isReady()) await this.warmup();
    if (!this.isReady()) return [];
    const model = this.model as SeqClassModel;
    const tokenizer = this.tokenizer as Tokenizer;
    const scores: number[] = [];
    for (const doc of documents) {
      const inputs = await tokenizer(query, {
        text_pair: doc,
        padding: true,
        truncation: true,
      });
      const out = await model(inputs);
      scores.push(Number(out.logits.data[0]));
    }
    return scores;
  }
}
