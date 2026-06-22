import { Logger } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Semaphore } from '../../common/semaphore';
import type { EmbedderProvider } from './embedder-provider.interface';

interface FeatureExtractionPipeline {
  (
    input: string | string[],
    opts?: { pooling?: 'cls' | 'mean'; normalize?: boolean },
  ): Promise<{ data: Float32Array | number[] }>;
}

export interface BgeM3EmbedderConfig {
  modelId: string;
  /** BGE-M3 native dim is 1024; configurable for downstream truncation. */
  dimensions: number;
  concurrency: number;
  /**
   * When true (default), inference runs in a worker_thread so each
   * embed doesn't block the main event loop. Disable for tests or
   * single-threaded benchmarks via BGE_M3_WORKER=0.
   */
  useWorker?: boolean;
}

/**
 * BGE-M3 embedding provider — multilingual dense embeddings via
 * `@xenova/transformers` (arXiv:2402.03216, 2024).
 *
 * Default runtime: a dedicated `worker_thread` owns the model and
 * receives `embed` / `embedMany` RPCs over postMessage. The main
 * thread serves HTTP without ONNX inference (WASM or native) stealing
 * CPU. Why this matters: a 1024-dim embed burns 20-200ms; with BGE
 * concurrency = 4 and main-thread inference, the event loop pauses
 * 80-800ms — every other tenant's request blocks for the duration.
 *
 * Fallback: when BGE_M3_WORKER=0 or the worker file can't be loaded
 * (some test envs), the provider falls back to in-thread inference
 * preserving the original behaviour.
 */
export class BgeM3EmbedderProvider implements EmbedderProvider {
  readonly providerId: string;
  private readonly logger = new Logger(BgeM3EmbedderProvider.name);
  private readonly modelId: string;
  private readonly dimensions: number;
  private readonly limiter: Semaphore;
  private readonly useWorker: boolean;

  // In-thread fallback
  private pipeline: FeatureExtractionPipeline | null = null;

  // Worker runtime
  private worker: Worker | null = null;
  private workerReady = false;
  private nextReqId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(cfg: BgeM3EmbedderConfig) {
    this.modelId = cfg.modelId;
    this.dimensions = cfg.dimensions;
    this.providerId = `bge-m3:${cfg.modelId}:${cfg.dimensions}`;
    this.limiter = new Semaphore(cfg.concurrency);
    // Worker is OPT-IN — callers (EmbedderService) flip via env. Tests
    // construct the provider directly and rely on the in-thread path
    // via setPipelineForTesting().
    this.useWorker = cfg.useWorker === true;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  isReady(): boolean {
    return this.useWorker ? this.workerReady : this.pipeline !== null;
  }

  /** Test seam — drive the BGE path without loading the real model. */
  setPipelineForTesting(p: FeatureExtractionPipeline | null): void {
    this.pipeline = p;
    // Tests bypass the worker by setting useWorker=false at construction.
  }

  async warmup(): Promise<void> {
    if (this.useWorker) {
      await this.warmupWorker();
      return;
    }
    await this.warmupInThread();
  }

  async embed(text: string): Promise<number[]> {
    if (this.useWorker) {
      if (!this.workerReady) {
        throw new Error('BGE-M3 worker not ready — caller must check isReady()');
      }
      const trimmed = text.trim();
      if (!trimmed) return new Array(this.dimensions).fill(0);
      return this.limiter.run(
        () => this.rpc<number[]>('embed', { text: trimmed }),
      );
    }
    if (!this.pipeline) {
      throw new Error('BGE-M3 pipeline not ready — caller must check isReady()');
    }
    const trimmed = text.trim();
    if (!trimmed) return new Array(this.dimensions).fill(0);
    return this.limiter.run(() => this.inThreadEmbed(trimmed));
  }

  private async warmupInThread(): Promise<void> {
    const start = Date.now();
    try {
      const transformers = await import('@xenova/transformers');
      this.pipeline = (await transformers.pipeline(
        'feature-extraction',
        this.modelId,
      )) as unknown as FeatureExtractionPipeline;
      this.logger.log(
        `BGE-M3 ready (${this.modelId}) — in-thread warmup ${Date.now() - start}ms`,
      );
    } catch (e) {
      this.logger.warn(
        `BGE-M3 warmup failed for ${this.modelId}: ${(e as Error).message}; service will fall back to OpenAI`,
      );
      this.pipeline = null;
    }
  }

  private async warmupWorker(): Promise<void> {
    const start = Date.now();
    try {
      const workerPath = this.resolveWorkerPath();
      this.worker = new Worker(workerPath);
      this.worker.on('message', (m: unknown) => this.handleReply(m));
      this.worker.on('error', (err) => {
        this.logger.warn(`BGE-M3 worker error: ${err.message}`);
        this.failAllPending(err);
        this.workerReady = false;
      });
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          this.logger.warn(`BGE-M3 worker exited with code ${code}`);
        }
        this.failAllPending(new Error('worker exited'));
        this.workerReady = false;
      });
      await this.rpc<{ ready: boolean }>('warmup', {
        modelId: this.modelId,
        dimensions: this.dimensions,
      });
      this.workerReady = true;
      this.logger.log(
        `BGE-M3 ready (${this.modelId}) — worker warmup ${Date.now() - start}ms`,
      );
    } catch (e) {
      this.logger.warn(
        `BGE-M3 worker warmup failed for ${this.modelId}: ${(e as Error).message}; service will fall back to OpenAI`,
      );
      this.workerReady = false;
    }
  }

  /**
   * Terminate the inference worker thread. A `worker_threads.Worker`
   * keeps the event loop alive until terminated, so the owning
   * EmbedderService must call this on shutdown (otherwise the process —
   * and the e2e jest run — hangs). Idempotent.
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

  private resolveWorkerPath(): string {
    // After ts-jest / nest build the worker compiles to .js next to .ts.
    // In dev (ts-node) we point at the .ts via ts-node loader. The two
    // candidates cover both layouts.
    const distCandidate = join(__dirname, 'bge-m3.worker.js');
    if (existsSync(distCandidate)) return distCandidate;
    return join(__dirname, 'bge-m3.worker.ts');
  }

  private handleReply(msg: unknown): void {
    const m = msg as {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    };
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

  private rpc<R>(kind: 'warmup' | 'embed' | 'embedMany', payload: unknown): Promise<R> {
    if (!this.worker) {
      return Promise.reject(new Error('BGE-M3 worker not initialised'));
    }
    const id = this.nextReqId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.worker!.postMessage({ id, kind, payload });
    });
  }

  private async inThreadEmbed(trimmed: string): Promise<number[]> {
    const out = await this.pipeline!(trimmed, {
      pooling: 'cls',
      normalize: true,
    });
    const v = Array.from(out.data as Iterable<number>);
    if (v.length === this.dimensions) return v;
    if (v.length > this.dimensions) return v.slice(0, this.dimensions);
    const padded = new Array(this.dimensions).fill(0);
    for (let i = 0; i < v.length; i++) padded[i] = v[i];
    return padded;
  }
}
