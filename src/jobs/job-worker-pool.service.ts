import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  ready: boolean;
  inFlight: PendingRequest | null;
}

/**
 * JobWorkerPool — fixed-size node:worker_threads pool used by the
 * dispatcher to run CPU-bound job handlers off the main event loop.
 *
 *   register('reindex_embeddings', handler, { cpuBound: true,
 *     workerModule: __dirname + '/reindex.worker-job.js' })
 *
 * The dispatcher (WorkerLoopService) calls pool.run(workerModule,
 * serialisableInput) and awaits the worker's reply. The handler runs
 * in the worker's event loop, owning a chunk of CPU that previously
 * blocked the main thread (extractor span-grounding, large-batch
 * vector math, BGE-M3 inference for handlers that don't already use
 * the dedicated bge-m3.worker).
 *
 * Tradeoffs vs in-thread:
 *   - AbortSignal does NOT propagate across the postMessage boundary.
 *     Long-running worker code must check a cooperative
 *     `cancelRequested` payload between batches.
 *   - Input + result MUST be structured-clone-able. Pass plain
 *     objects, primitives, ArrayBuffers. No class instances with
 *     methods, no closures.
 *   - Modules are cached inside each worker, so a hot handler doesn't
 *     pay import cost on every call.
 *
 * Concurrency: each worker handles one job at a time. JOB_WORKER_POOL_SIZE
 * controls the parallelism (default 2). When all workers are busy,
 * additional callers queue in `waiters`.
 *
 * Disabled when JOB_WORKER_POOL_SIZE=0 — pool.run throws so callers
 * fall back to the in-thread path inside the dispatcher.
 */
@Injectable()
export class JobWorkerPool implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobWorkerPool.name);
  private readonly poolSize: number;
  private readonly workers: PooledWorker[] = [];
  private readonly idle: PooledWorker[] = [];
  private readonly waiters: Array<(w: PooledWorker) => void> = [];
  private nextReqId = 1;
  private shuttingDown = false;

  constructor(config: ConfigService) {
    this.poolSize = parseInt(
      config.get<string>('JOB_WORKER_POOL_SIZE', '2') ?? '2',
      10,
    );
  }

  enabled(): boolean {
    return this.poolSize > 0;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled()) {
      this.logger.log('Job worker pool disabled (JOB_WORKER_POOL_SIZE=0)');
      return;
    }
    const runnerPath = this.resolveRunnerPath();
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const w = await this.spawnWorker(runnerPath);
        this.workers.push(w);
        this.idle.push(w);
      } catch (e) {
        this.logger.warn(
          `Failed to spawn pool worker ${i}: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Job worker pool ready — size=${this.workers.length}/${this.poolSize}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    // Reject any queued waiters cleanly.
    for (const waiter of this.waiters.splice(0)) {
      try {
        waiter({} as PooledWorker);
      } catch {
        /* ignore */
      }
    }
    await Promise.all(
      this.workers.map(async (w) => {
        if (w.inFlight) {
          w.inFlight.reject(new Error('pool shutting down'));
          w.inFlight = null;
        }
        await w.worker.terminate().catch(() => undefined);
      }),
    );
    this.workers.length = 0;
    this.idle.length = 0;
  }

  /**
   * Send (modulePath, input) to a pool worker; await its result.
   *
   * The worker dynamic-imports modulePath the first time it sees it
   * (cached thereafter) and calls its exported `run(input)`. Throws
   * if the pool is disabled, no workers are healthy, OR the handler
   * threw inside the worker (re-thrown with original message + name).
   */
  async run<R = unknown>(modulePath: string, input: unknown): Promise<R> {
    if (!this.enabled()) {
      throw new Error('JobWorkerPool disabled');
    }
    if (this.shuttingDown) {
      throw new Error('JobWorkerPool shutting down');
    }
    const w = await this.acquire();
    const id = this.nextReqId++;
    try {
      return await new Promise<R>((resolve, reject) => {
        w.inFlight = {
          resolve: (v) => resolve(v as R),
          reject,
        };
        w.worker.postMessage({ id, kind: 'run', modulePath, input });
      });
    } finally {
      w.inFlight = null;
      this.release(w);
    }
  }

  /** Test seam — operator observability via /admin/leases. */
  stats(): { size: number; idle: number; busy: number; waiters: number } {
    return {
      size: this.workers.length,
      idle: this.idle.length,
      busy: this.workers.length - this.idle.length,
      waiters: this.waiters.length,
    };
  }

  private acquire(): Promise<PooledWorker> {
    const free = this.idle.shift();
    if (free) return Promise.resolve(free);
    return new Promise<PooledWorker>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(w: PooledWorker): void {
    if (this.shuttingDown) return;
    const next = this.waiters.shift();
    if (next) next(w);
    else this.idle.push(w);
  }

  private resolveRunnerPath(): string {
    // After nest build, the runner compiles to .js alongside the .ts.
    // In dev (ts-node), the .ts loader handles the .ts directly.
    const distCandidate = join(__dirname, 'job-worker-runner.js');
    if (existsSync(distCandidate)) return distCandidate;
    return join(__dirname, 'job-worker-runner.ts');
  }

  private spawnWorker(runnerPath: string): Promise<PooledWorker> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(runnerPath);
      const slot: PooledWorker = { worker, ready: false, inFlight: null };
      const readyTimer = setTimeout(() => {
        reject(new Error('Worker readiness timeout (5s)'));
        worker.terminate().catch(() => undefined);
      }, 5_000);
      worker.on('message', (m: unknown) => {
        const msg = m as {
          id: number;
          ok: boolean;
          result?: unknown;
          error?: string;
          name?: string;
        };
        if (msg.id === 0 && msg.ok) {
          // Boot ack.
          clearTimeout(readyTimer);
          slot.ready = true;
          resolve(slot);
          return;
        }
        const inFlight = slot.inFlight;
        if (!inFlight) {
          this.logger.warn(`Stray worker reply id=${msg.id} (no in-flight)`);
          return;
        }
        if (msg.ok) inFlight.resolve(msg.result);
        else {
          const err = new Error(msg.error ?? 'worker error');
          if (msg.name) err.name = msg.name;
          inFlight.reject(err);
        }
      });
      worker.on('error', (err) => {
        clearTimeout(readyTimer);
        if (slot.inFlight) {
          slot.inFlight.reject(err);
          slot.inFlight = null;
        }
        this.logger.warn(`Worker error: ${err.message}`);
      });
      worker.on('exit', (code) => {
        if (slot.inFlight) {
          slot.inFlight.reject(new Error(`worker exited (code ${code})`));
          slot.inFlight = null;
        }
        // Remove from pool tracking — onApplicationShutdown is best-
        // effort, an unexpected exit just shrinks the pool.
        const i = this.workers.indexOf(slot);
        if (i >= 0) this.workers.splice(i, 1);
        const j = this.idle.indexOf(slot);
        if (j >= 0) this.idle.splice(j, 1);
      });
    });
  }
}
