/**
 * Phase 4.D — provider abstraction for the embedding stage.
 *
 * Lets the EmbedderService switch between OpenAI (text-embedding-3-*,
 * the existing path) and BGE-M3 (multilingual dense embeddings via
 * @xenova/transformers — see arXiv:2402.03216, 2024) via an env knob
 * without touching the call sites in HyPE / search / ingest.
 *
 * Provider implementations are responsible for:
 *   - returning a dense float vector of `getDimensions()` length
 *   - returning the zero vector for empty / whitespace input
 *   - reporting `isReady()` so the service can fall back gracefully
 *     when a model warmup is in progress or has failed
 */
export interface EmbedderProvider {
  /** Stable identifier used in cache keys and metrics. */
  readonly providerId: string;

  /**
   * Total dimensions of the emitted vector. Constant per provider
   * instance — providers that vary dim by request are not supported.
   */
  getDimensions(): number;

  /**
   * True once the provider can serve `embed()` calls. For OpenAI this
   * is `true` right after construction; for BGE-M3 it flips after the
   * @xenova/transformers warmup resolves.
   */
  isReady(): boolean;

  /** Embed a single string. Empty / whitespace → zero vector. */
  embed(text: string): Promise<number[]>;

  /**
   * Optional batched API. Providers that support it return one vector
   * per input in the same order. Implementations that don't override
   * fall back to N sequential `embed()` calls via the default in
   * EmbedderService — correct but pays N round-trips. OpenAI's
   * `/embeddings` endpoint accepts arrays up to 2048; BGE-M3 can
   * compute a batch in one pass.
   */
  embedMany?(texts: string[]): Promise<number[][]>;
}
