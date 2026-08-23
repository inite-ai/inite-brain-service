import { Logger } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local cross-encoder reranker via `@xenova/transformers`
 * (`AutoModelForSequenceClassification`, default `Xenova/bge-reranker-base`).
 *
 * The no-Cohere-key fallback for the rerank stage: when `COHERE_API_KEY` is
 * absent, this scores each (query, document)
 * pair with a joint encoder — real query×document attention, not pooled
 * embeddings.
 *
 * Runtime: a dedicated `worker_thread` owns the model (default), so ONNX
 * inference never blocks the main event loop — the reranker model is
 * xlm-roberta-base (~278M params) and a full window on the main thread would
 * freeze every other tenant's request. `useWorker: false` keeps the original
 * in-thread path for unit tests and single-threaded benchmarks.
 *
 * The model is lazy-loaded on first use (or an explicit boot `warmup()`).
 * Until warmup resolves `isReady()` is false and the caller keeps the fusion
 * order. A failed warmup latches for `FAIL_RETRY_MS` (so we don't re-download
 * on every request) but is retried afterwards — a transient network blip at
 * first use no longer disables the fallback until the next process restart.
 */

/** Minimal shape of the transformers.js pieces we use (in-thread path). */
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
  /** Run inference in a worker_thread (default true). Off for unit tests. */
  useWorker?: boolean;
  /** Per-score RPC / warmup budget for the worker path. */
  scoreTimeoutMs?: number;
}

const WORKER_WARMUP_TIMEOUT_MS = 120_000;
const DEFAULT_SCORE_TIMEOUT_MS = 8_000;
const FAIL_RETRY_MS = 5 * 60_000;

export class LocalCrossEncoderProvider {
  readonly modelId: string;
  private readonly logger = new Logger(LocalCrossEncoderProvider.name);
  private readonly useWorker: boolean;
  private readonly scoreTimeoutMs: number;

  // In-thread fallback
  private tokenizer: Tokenizer | null = null;
  private model: SeqClassModel | null = null;

  // Worker runtime
  private worker: Worker | null = null;
  private workerReady = false;
  private nextReqId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private warmupPromise: Promise<void> | null = null;
  private failedUntil = 0;

  constructor(cfg: LocalCrossEncoderConfig) {
    this.modelId = cfg.modelId;
    this.useWorker = cfg.useWorker !== false;
    this.scoreTimeoutMs = cfg.scoreTimeoutMs ?? DEFAULT_SCORE_TIMEOUT_MS;
  }

  isReady(): boolean {
    return this.useWorker ? this.workerReady : this.tokenizer !== null && this.model !== null;
  }

  /** Load (or await the in-flight load of) the model. Idempotent; a failed
   *  load latches for FAIL_RETRY_MS so we don't re-download every call. */
  async warmup(): Promise<void> {
    if (this.isReady()) return;
    if (this.warmupPromise) return this.warmupPromise;
    if (Date.now() < this.failedUntil) return;
    this.warmupPromise = (this.useWorker ? this.warmupWorker() : this.warmupInThread())
      .catch((e) => {
        this.failedUntil = Date.now() + FAIL_RETRY_MS;
        this.logger.warn(
          `local cross-encoder warmup failed (${(e as Error).message}); rerank keeps fusion order, retrying after ${Math.round(FAIL_RETRY_MS / 60000)}m`,
        );
      })
      .finally(() => {
        this.warmupPromise = null;
      });
    return this.warmupPromise;
  }

  /**
   * Relevance score per document (higher = more relevant). Returns an empty
   * array on any failure so the caller falls back to the identity permutation.
   * `deadlineMs` bounds the worker's scoring loop (unscored docs sink).
   */
  async score(query: string, documents: string[], deadlineMs?: number): Promise<number[]> {
    if (Date.now() < this.failedUntil) return [];
    if (!this.isReady()) await this.warmup();
    if (!this.isReady()) return [];
    try {
      if (this.useWorker) {
        return await this.rpc<number[]>('score', {
          query,
          documents,
          deadlineMs: deadlineMs ?? this.scoreTimeoutMs,
        });
      }
      return await this.scoreInThread(query, documents, deadlineMs);
    } catch (e) {
      this.logger.warn(`local cross-encoder score failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Terminate the inference worker thread. A worker_threads.Worker keeps the
   * event loop alive until terminated, so the owner (CrossEncoderService)
   * must call this on shutdown. Idempotent.
   */
  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.workerReady = false;
    if (w) {
      this.failAllPending(new Error('worker terminated on shutdown'));
      await w.terminate().catch(() => undefined);
    }
  }

  private async warmupInThread(): Promise<void> {
    const t = (await import('@xenova/transformers')) as unknown as {
      env: { cacheDir?: string };
      AutoTokenizer: { from_pretrained: (id: string) => Promise<Tokenizer> };
      AutoModelForSequenceClassification: {
        from_pretrained: (id: string, opts?: { quantized?: boolean }) => Promise<SeqClassModel>;
      };
    };
    const cacheDir = process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME;
    if (cacheDir) t.env.cacheDir = cacheDir;
    this.tokenizer = await t.AutoTokenizer.from_pretrained(this.modelId);
    this.model = await t.AutoModelForSequenceClassification.from_pretrained(this.modelId, {
      quantized: true,
    });
  }

  private async warmupWorker(): Promise<void> {
    // Re-warmup after a score-RPC timeout must not orphan the previous
    // worker: an un-terminated worker_threads.Worker keeps its message
    // listener (and the ~300 MB loaded model) alive for the process
    // lifetime — one leaked worker per timeout incident. Tear the old
    // one down before spawning its replacement.
    const stale = this.worker;
    if (stale) {
      this.worker = null;
      this.failAllPending(new Error('worker replaced after stall'));
      await stale.terminate().catch(() => undefined);
    }
    const workerPath = this.resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.on('message', (m: unknown) => this.handleReply(m));
    this.worker.on('error', (err) => {
      this.logger.warn(`cross-encoder worker error: ${err.message}`);
      this.failAllPending(err);
      this.workerReady = false;
    });
    this.worker.on('exit', (code) => {
      if (code !== 0) this.logger.warn(`cross-encoder worker exited (${code})`);
      this.failAllPending(new Error('worker exited'));
      this.workerReady = false;
    });
    await this.rpc<{ ready: boolean }>('warmup', { modelId: this.modelId });
    this.workerReady = true;
  }

  private resolveWorkerPath(): string {
    const distCandidate = join(__dirname, 'cross-encoder.worker.js');
    if (existsSync(distCandidate)) return distCandidate;
    return join(__dirname, 'cross-encoder.worker.ts');
  }

  private handleReply(msg: unknown): void {
    const m = msg as { id: number; ok: boolean; result?: unknown; error?: string };
    const entry = this.pending.get(m.id);
    if (!entry) return;
    this.pending.delete(m.id);
    if (m.ok) entry.resolve(m.result);
    else entry.reject(new Error(m.error ?? 'unknown worker error'));
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  private rpc<R>(kind: 'warmup' | 'score', payload: unknown): Promise<R> {
    if (!this.worker) {
      return Promise.reject(new Error('cross-encoder worker not initialised'));
    }
    const id = this.nextReqId++;
    // Warmup loads ~279MB from disk/network; a score call is bounded by its
    // own deadline plus slack so a wedged worker can't pend forever.
    const timeoutMs = kind === 'warmup' ? WORKER_WARMUP_TIMEOUT_MS : this.scoreTimeoutMs + 2_000;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.workerReady = false;
          // Latch like a warmup failure: without this, the next score()
          // immediately re-warms (spawning a replacement worker) while
          // the wedged one may still be mid-inference — on a
          // persistently slow host that cycled a new ~300 MB worker per
          // timeout. The latch gives the host FAIL_RETRY_MS to recover;
          // rerank degrades to fusion order meanwhile.
          if (kind === 'score') {
            this.failedUntil = Date.now() + FAIL_RETRY_MS;
          }
          reject(new Error(`cross-encoder '${kind}' RPC timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          (resolve as (value: unknown) => void)(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.worker!.postMessage({ id, kind, payload });
    });
  }

  private async scoreInThread(
    query: string,
    documents: string[],
    deadlineMs?: number,
  ): Promise<number[]> {
    const model = this.model as SeqClassModel;
    const tokenizer = this.tokenizer as Tokenizer;
    const deadline = deadlineMs && deadlineMs > 0 ? Date.now() + deadlineMs : undefined;
    const scores: number[] = new Array(documents.length).fill(Number.NEGATIVE_INFINITY);
    for (const [i, doc] of documents.entries()) {
      if (deadline !== undefined && Date.now() > deadline) break;
      const inputs = await tokenizer(query, {
        text_pair: doc,
        padding: true,
        truncation: true,
      });
      const out = await model(inputs);
      scores[i] = Number(out.logits.data[0]);
    }
    return scores;
  }
}
