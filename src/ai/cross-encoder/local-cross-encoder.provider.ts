import { Logger } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyTransformersCacheDir } from '../transformers-cache';
import { scorePairs, type PairScorer } from './score-pairs';

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
 *
 * Deadline contract: `score()` takes the ABSOLUTE time by which the caller
 * wants its answer and stops the scoring loop `SCORE_MARGIN_MS` before it,
 * so the partial result (score-pairs.ts) is back in the caller's hands
 * before the caller's own stage timer fires — the opposite of the previous
 * relative deadline, which equalled the stage budget and lost the race to
 * it on every call from a slow host.
 */

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
/**
 * How far inside the caller's deadline the scoring loop stops: the worker
 * round-trip plus the last chunk's overshoot risk (the loop estimates a
 * chunk from the worst pair seen so far, so the overshoot is bounded by
 * one padded chunk on a host slower than its own history).
 */
export const SCORE_MARGIN_MS = 250;

export class LocalCrossEncoderProvider {
  readonly modelId: string;
  private readonly logger = new Logger(LocalCrossEncoderProvider.name);
  private readonly useWorker: boolean;
  private readonly scoreTimeoutMs: number;

  // In-thread fallback
  private scorer: PairScorer | null = null;

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
    return this.useWorker ? this.workerReady : this.scorer !== null;
  }

  /** Load (or await the in-flight load of) the model. Idempotent; a failed
   *  load latches for FAIL_RETRY_MS so we don't re-download every call. */
  async warmup(): Promise<void> {
    if (this.isReady()) return;
    if (this.warmupPromise) return this.warmupPromise;
    if (Date.now() < this.failedUntil) return;
    const start = Date.now();
    this.warmupPromise = (this.useWorker ? this.warmupWorker() : this.warmupInThread())
      .then(() => {
        this.logger.log(
          `local cross-encoder ready (${this.modelId}, ${this.useWorker ? 'worker' : 'in-thread'}) — warmup ${Date.now() - start}ms`,
        );
      })
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
   * `deadlineAt` (epoch ms) is when the caller wants the answer: the loop
   * stops SCORE_MARGIN_MS before it and the unscored tail sinks (-Infinity).
   * Without a deadline the per-score RPC timeout is the only bound.
   */
  async score(query: string, documents: string[], deadlineAt?: number): Promise<number[]> {
    if (Date.now() < this.failedUntil) return [];
    if (!this.isReady()) await this.warmup();
    if (!this.isReady()) return [];
    const stopAt =
      deadlineAt === undefined ? Date.now() + this.scoreTimeoutMs : deadlineAt - SCORE_MARGIN_MS;
    try {
      if (this.useWorker) {
        return await this.rpc<number[]>('score', { query, documents, deadlineAt: stopAt });
      }
      return await scorePairs(this.scorer as PairScorer, { query, documents, deadlineAt: stopAt });
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
      AutoTokenizer: { from_pretrained: (id: string) => Promise<PairScorer['tokenizer']> };
      AutoModelForSequenceClassification: {
        from_pretrained: (
          id: string,
          opts?: { quantized?: boolean },
        ) => Promise<PairScorer['model']>;
      };
    };
    applyTransformersCacheDir(t);
    const tokenizer = await t.AutoTokenizer.from_pretrained(this.modelId);
    const model = await t.AutoModelForSequenceClassification.from_pretrained(this.modelId, {
      quantized: true,
    });
    const loaded: PairScorer = { tokenizer, model };
    await scorePairs(loaded, { query: 'warmup', documents: ['warmup'] });
    this.scorer = loaded;
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
    const w = new Worker(workerPath);
    this.worker = w;
    // Every listener checks it still speaks for the CURRENT worker:
    // terminate() and a re-warmup both null/replace `this.worker` before
    // the old thread exits, and a thread we no longer own must neither
    // log its exit as a failure nor mark the provider not-ready.
    w.on('message', (m: unknown) => {
      if (this.worker !== w) return;
      this.handleReply(m);
    });
    w.on('error', (err) => {
      if (this.worker !== w) return;
      this.logger.warn(`cross-encoder worker error: ${err.message}`);
      this.failAllPending(err);
      this.workerReady = false;
    });
    w.on('exit', (code) => {
      if (this.worker !== w) return;
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
}
