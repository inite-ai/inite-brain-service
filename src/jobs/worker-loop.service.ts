import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { LeaderLeaseService } from './leader-lease.service';
import { MetricsService } from '../metrics/metrics.service';
import { WorkerPollerService } from './worker-poller.service';
import type { JobType } from './job-run.service';
import type { PollControl, RegisteredHandler } from './worker-loop.types';
import { envFlagNotDisabled } from '../common/env-validation';

export type { JobContext, JobHandler } from './worker-loop.types';

/**
 * How long shutdown waits for in-flight dispatches before handing their
 * claims back to the queue. Sits after the readiness drain and inside the
 * hard stop (GracefulShutdownService), under compose's stop_grace_period.
 */
const DISPATCH_DRAIN_MS = 12_000;

/**
 * WorkerLoopService — leader election + handler registry + lifecycle for
 * the job_run queue worker. Holds the @Cron-less lease loop: it acquires
 * the worker_loop lease, and while leader spins up one WorkerPollerService
 * loop per registered jobType. The poll/claim mechanics live in
 * WorkerPollerService and the per-job dispatch in JobDispatcherService —
 * this class keeps ≤3 injected deps (poller, lease, metrics).
 *
 * register() is the public surface module-owner services call from their
 * onModuleInit; the registry must be complete before the lease loop spins
 * up. Cadence/enabled flags read from the environment.
 */
@Injectable()
export class WorkerLoopService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkerLoopService.name);
  private readonly handlers = new Map<JobType, RegisteredHandler>();
  private readonly enabled = envFlagNotDisabled(process.env.WORKER_LOOP_ENABLED);
  private readonly leaseRenewIntervalMs = parseInt(
    process.env.WORKER_LOOP_LEASE_RENEW_MS ?? '30000',
    10,
  );
  private readonly abortController = new AbortController();
  private leaseTimer: NodeJS.Timeout | null = null;
  private isLeader = false;
  /** Fencing epoch of the worker_loop lease we hold; null when not leader. */
  private epoch: number | null = null;
  private loopsStarted = false;
  /** The running poll loops; each settles after its own dispatches do. */
  private loops: Promise<void>[] = [];

  constructor(
    private readonly poller: WorkerPollerService,
    @Optional() private readonly lease?: LeaderLeaseService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Register a handler for a job type. Called from module-owner
   * services' onModuleInit so the registry is complete by the time the
   * leader loop spins up.
   */
  register(
    jobType: JobType,
    handler: RegisteredHandler['handler'],
    opts?: {
      ttlSeconds?: number;
      maxAttempts?: number;
      cpuBound?: boolean;
      workerModule?: string;
    },
  ): void {
    if (this.handlers.has(jobType)) {
      this.logger.warn(`Re-registering handler for ${jobType}`);
    }
    if (opts?.cpuBound && !opts.workerModule) {
      throw new Error(`register(${jobType}): cpuBound=true requires workerModule`);
    }
    this.handlers.set(jobType, {
      jobType,
      handler,
      ttlSeconds: opts?.ttlSeconds ?? 300,
      maxAttempts: opts?.maxAttempts ?? 3,
      cpuBound: opts?.cpuBound ?? false,
      workerModule: opts?.workerModule,
    });
    this.logger.log(
      `Registered handler for jobType=${jobType}` +
        (opts?.cpuBound ? ' (cpuBound → worker pool)' : ''),
    );
  }

  registeredTypes(): JobType[] {
    return [...this.handlers.keys()];
  }

  /** True iff this pod currently holds the worker_loop lease. */
  leader(): boolean {
    return this.isLeader;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('Worker loop disabled (WORKER_LOOP_ENABLED=0)');
      return;
    }
    if (!this.poller.hasClaim) {
      this.logger.warn('JobClaimService not available — worker loop inert');
      return;
    }
    // Defer the first lease acquisition by one tick so module-owners get
    // a chance to register their handlers in their own onModuleInit
    // before we start polling for jobs we can't dispatch.
    this.leaseTimer = setTimeout(
      () => void this.tryBecomeLeader(),
      this.leaseRenewIntervalMs / 6, // 5s by default
    );
    this.poller.startDecay();
  }

  // beforeApplicationShutdown (phase 2), NOT onApplicationShutdown (phase 3):
  // the lease release below is a DB write, and SurrealService closes the pool
  // in onApplicationShutdown. Running here guarantees the pool is still open
  // when we release — otherwise the lease zombied for a full TTL on every
  // deploy and in-flight jobs were orphaned.
  async beforeApplicationShutdown(): Promise<void> {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.poller.stopDecay();
    this.abortController.abort();
    this.metrics?.setWorkerLeader(false);
    await this.drainDispatches();
    if (this.isLeader && this.lease) {
      try {
        await this.lease.release('worker_loop');
      } catch (e) {
        this.logger.warn(`release(worker_loop) failed: ${(e as Error).message}`);
      }
    }
    this.logger.log('Worker loop shut down');
  }

  /**
   * Wait for the poll loops — and the dispatches they own — to settle.
   * Past the budget, hand every still-running claim back to the queue so
   * the next leader can take it now instead of waiting out a lease this
   * dying pod will never renew. Runs BEFORE the lease release: the claims
   * are ours until then.
   */
  private async drainDispatches(): Promise<void> {
    if (this.loops.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), DISPATCH_DRAIN_MS);
      timer.unref();
    });
    const drained = await Promise.race([
      Promise.allSettled(this.loops).then(() => true as const),
      budget,
    ]);
    if (timer) clearTimeout(timer);
    if (drained) return;
    const stuck = this.poller.activeClaims().length;
    const released = await this.poller.releaseActiveClaims(
      'pod shutdown: handler did not stop within the drain budget',
    );
    this.logger.warn(
      `${stuck} dispatch(es) still running after ${DISPATCH_DRAIN_MS} ms; ` +
        `released ${released} claim(s) back to the queue`,
    );
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    if (!this.lease) {
      // No lease service — assume single-pod dev/test. Start loops
      // immediately if we have handlers registered.
      this.isLeader = true;
      this.epoch = null;
    } else {
      try {
        const epoch = await this.lease.acquire(
          'worker_loop',
          Math.ceil((this.leaseRenewIntervalMs * 3) / 1000),
        );
        const got = epoch !== null;
        if (got !== this.isLeader) {
          this.logger.log(
            got
              ? `Acquired worker_loop lease (epoch ${epoch}) — starting poll loops`
              : 'Lost worker_loop lease — pausing poll loops',
          );
        }
        this.isLeader = got;
        this.epoch = epoch;
      } catch (e) {
        this.logger.warn(`worker_loop lease acquire failed: ${(e as Error).message}`);
        this.isLeader = false;
        this.epoch = null;
      }
    }
    this.metrics?.setWorkerLeader(this.isLeader);
    if (this.isLeader && !this.loopsStarted) this.startLoops();
    if (!this.abortController.signal.aborted) {
      this.leaseTimer = setTimeout(() => void this.tryBecomeLeader(), this.leaseRenewIntervalMs);
    }
  }

  /**
   * Point-read the lease before a claim: a pod that lost it must stop
   * claiming now, not at the next renew tick up to a full interval away.
   */
  private async confirmLeader(): Promise<boolean> {
    if (!this.lease) return this.isLeader;
    if (!this.isLeader) return false;
    const held = await this.lease.isHeld('worker_loop', this.epoch ?? undefined);
    if (!held) {
      this.logger.log('worker_loop lease no longer ours — stopping poll loops');
      this.isLeader = false;
      this.epoch = null;
      this.metrics?.setWorkerLeader(false);
    }
    return held;
  }

  /**
   * One loop per registered jobType. Loops end when leadership is lost;
   * the renew tick starts a fresh set once the lease is ours again. The
   * promises are kept so shutdown can await the dispatches they own.
   */
  private startLoops(): void {
    this.loopsStarted = true;
    const control: PollControl = {
      isLeader: () => this.isLeader,
      confirmLeader: () => this.confirmLeader(),
      epoch: () => this.epoch,
      signal: this.abortController.signal,
      onInFlight: (jobType, inFlight) => this.metrics?.setWorkerJobsInFlight(jobType, inFlight),
    };
    this.loops = [...this.handlers.values()].map((reg) =>
      this.poller.runLoop(reg, control).catch((e: unknown) => {
        this.logger.warn(`poll loop (${reg.jobType}) died: ${(e as Error).message}`);
      }),
    );
    void Promise.allSettled(this.loops).then(() => {
      this.loopsStarted = false;
    });
  }
}
