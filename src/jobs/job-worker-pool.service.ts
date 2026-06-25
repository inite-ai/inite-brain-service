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

/**
 * A caller parked in `acquire()` because no worker was idle. Settled either
 * by `release()` handing it a worker, or — so it can never hang forever — by
 * its own acquire timeout / by `rejectAllWaiters` when the pool dies for good.
 */
interface Waiter {
  resolve: (w: PooledWorker) => void;
  reject: (err: Error) => void;
}

interface PooledWorker {
  worker: Worker;
  ready: boolean;
  inFlight: PendingRequest | null;
  /** Set once the worker has exited; such a slot must never be re-idled. */
  dead?: boolean;
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
  private readonly waiters: Array<Waiter> = [];
  private nextReqId = 1;
  private shuttingDown = false;
  /** Per-call ceiling: a worker stuck in a tight native loop emits no
   * message/exit, so without this its slot is pinned forever. On timeout we
   * terminate the worker (→ exit → respawn) and reject the caller. */
  private readonly callTimeoutMs: number;
  private readonly runnerPath: string;
  // Crash-loop backstop for respawns.
  private respawnAttempts = 0;
  private lastRespawnAt = 0;

  constructor(config: ConfigService) {
    this.poolSize = parseInt(
      config.get<string>('JOB_WORKER_POOL_SIZE', '2') ?? '2',
      10,
    );
    this.callTimeoutMs = parseInt(
      config.get<string>('JOB_WORKER_CALL_TIMEOUT_MS', '120000') ?? '120000',
      10,
    );
    this.runnerPath = this.resolveRunnerPath();
  }

  enabled(): boolean {
    return this.poolSize > 0;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled()) {
      this.logger.log('Job worker pool disabled (JOB_WORKER_POOL_SIZE=0)');
      return;
    }
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const w = await this.spawnWorker(this.runnerPath);
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
    // Reject any queued waiters cleanly so their `run()` rejects instead of
    // hanging until shutdown tears the process down.
    this.rejectAllWaiters(new Error('JobWorkerPool shutting down'));
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
    // acquire() may park us as a waiter; it rejects on its own timeout, on
    // shutdown, or when the pool dies for good — so we never hang here.
    const w = await this.acquire();
    if (this.shuttingDown) {
      this.release(w);
      throw new Error('JobWorkerPool shutting down');
    }
    const id = this.nextReqId++;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<R>((resolve, reject) => {
        w.inFlight = {
          resolve: (v) => resolve(v as R),
          reject,
        };
        timer = setTimeout(() => {
          if (!w.inFlight) return;
          w.inFlight = null;
          // Mark dead BEFORE terminate() so the finally's release() can't
          // re-idle this worker in the window before the async 'exit' fires.
          w.dead = true;
          this.logger.warn(
            `Worker call id=${id} timed out after ${this.callTimeoutMs}ms — ` +
              'terminating worker',
          );
          w.worker.terminate().catch(() => undefined);
          reject(
            new Error(`worker call timed out after ${this.callTimeoutMs}ms`),
          );
        }, this.callTimeoutMs);
        w.worker.postMessage({ id, kind: 'run', modulePath, input });
      });
    } finally {
      if (timer) clearTimeout(timer);
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
    return new Promise<PooledWorker>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      // Park timeout. Without it a caller waits forever when every worker is
      // dead and the respawn budget is spent — no release() ever fires. The
      // per-call timeout only arms after acquire() resolves, so it can't
      // cover this phase; this is the backstop for it.
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new Error(
            `worker acquire timed out after ${this.callTimeoutMs}ms — ` +
              'pool exhausted/degraded',
          ),
        );
      }, this.callTimeoutMs);
      timer.unref();
      // Wrap both settle paths so the timer is cleared exactly once whichever
      // fires first (release, shutdown, permanent-degradation, or timeout).
      waiter.resolve = (w) => {
        clearTimeout(timer);
        resolve(w);
      };
      waiter.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.push(waiter);
    });
  }

  /** Settle every parked caller with an error (shutdown / permanent death). */
  private rejectAllWaiters(err: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      try {
        waiter.reject(err);
      } catch {
        /* ignore */
      }
    }
  }

  private release(w: PooledWorker): void {
    if (this.shuttingDown) return;
    // A worker that crashed mid-job is already spliced out of `workers`
    // (and flagged dead) by the exit handler. Never re-idle / hand it to
    // a waiter — that would poison the pool: the next acquire() returns a
    // terminated worker whose postMessage no-ops and run() hangs forever.
    if (w.dead || !this.workers.includes(w)) return;
    const next = this.waiters.shift();
    if (next) next.resolve(w);
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
        slot.dead = true;
        if (slot.inFlight) {
          slot.inFlight.reject(new Error(`worker exited (code ${code})`));
          slot.inFlight = null;
        }
        // Remove from pool tracking.
        const i = this.workers.indexOf(slot);
        if (i >= 0) this.workers.splice(i, 1);
        const j = this.idle.indexOf(slot);
        if (j >= 0) this.idle.splice(j, 1);
        // Self-heal: replace a worker that had successfully booted and then
        // died unexpectedly. Slots that never readied (init/respawn failures)
        // are handled by their spawn caller, not here, to avoid double-spawn.
        if (!this.shuttingDown && slot.ready) {
          this.scheduleRespawn();
        }
      });
    });
  }

  /**
   * Spawn a replacement worker after an unexpected exit, with exponential
   * backoff and a crash-loop budget. Without the budget a worker that crashes
   * on boot (bad native dep) would respawn in a tight loop forever.
   */
  private scheduleRespawn(): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    // Reset the budget after a calm minute — transient crashes shouldn't
    // permanently consume it.
    if (now - this.lastRespawnAt > 60_000) this.respawnAttempts = 0;
    if (this.respawnAttempts >= this.poolSize * 5) {
      this.logger.error(
        `Worker respawn budget exhausted (${this.respawnAttempts}) — pool ` +
          `degraded at ${this.workers.length}/${this.poolSize}`,
      );
      // If no worker survives, nothing will ever hand a slot to parked
      // callers — fail them now instead of leaving them to the acquire
      // timeout. If some workers are still alive, their release() can still
      // serve waiters, so leave them parked.
      if (this.workers.length === 0) {
        this.rejectAllWaiters(
          new Error('worker pool permanently degraded — all workers dead'),
        );
      }
      return;
    }
    this.respawnAttempts++;
    this.lastRespawnAt = now;
    const delay = Math.min(100 * 2 ** this.respawnAttempts, 5_000);
    setTimeout(() => {
      if (this.shuttingDown) return;
      this.spawnWorker(this.runnerPath)
        .then((w) => {
          if (this.shuttingDown) {
            w.worker.terminate().catch(() => undefined);
            return;
          }
          this.workers.push(w);
          this.release(w); // hand to a waiter, else return to idle
          this.logger.log(
            `Respawned pool worker — size=${this.workers.length}/${this.poolSize}`,
          );
        })
        .catch((e) => {
          this.logger.warn(`Worker respawn failed: ${(e as Error).message}`);
          this.scheduleRespawn();
        });
    }, delay).unref();
  }
}
