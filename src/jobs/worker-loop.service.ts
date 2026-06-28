import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { LeaderLeaseService } from './leader-lease.service';
import { MetricsService } from '../metrics/metrics.service';
import { WorkerPollerService } from './worker-poller.service';
import type { JobType } from './job-run.service';
import type { PollControl, RegisteredHandler } from './worker-loop.types';

export type { JobContext, JobHandler } from './worker-loop.types';

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
export class WorkerLoopService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLoopService.name);
  private readonly handlers = new Map<JobType, RegisteredHandler>();
  private readonly enabled =
    (process.env.WORKER_LOOP_ENABLED ?? '1') !== '0';
  private readonly leaseRenewIntervalMs = parseInt(
    process.env.WORKER_LOOP_LEASE_RENEW_MS ?? '30000',
    10,
  );
  private readonly abortController = new AbortController();
  private leaseTimer: NodeJS.Timeout | null = null;
  private isLeader = false;
  private loopsStarted = false;

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
      throw new Error(
        `register(${jobType}): cpuBound=true requires workerModule`,
      );
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

  async onApplicationShutdown(): Promise<void> {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.poller.stopDecay();
    this.abortController.abort();
    this.metrics?.setWorkerLeader(false);
    if (this.isLeader && this.lease) {
      try {
        await this.lease.release('worker_loop');
      } catch (e) {
        this.logger.warn(`release(worker_loop) failed: ${(e as Error).message}`);
      }
    }
    this.logger.log('Worker loop shut down');
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.abortController.signal.aborted) return;
    if (!this.lease) {
      // No lease service — assume single-pod dev/test. Start loops
      // immediately if we have handlers registered.
      this.isLeader = true;
    } else {
      try {
        const got = await this.lease.tryAcquire(
          'worker_loop',
          Math.ceil((this.leaseRenewIntervalMs * 3) / 1000),
        );
        if (got !== this.isLeader) {
          this.logger.log(
            got
              ? 'Acquired worker_loop lease — starting poll loops'
              : 'Lost worker_loop lease — pausing poll loops',
          );
        }
        this.isLeader = got;
      } catch (e) {
        this.logger.warn(
          `worker_loop lease acquire failed: ${(e as Error).message}`,
        );
        this.isLeader = false;
      }
    }
    this.metrics?.setWorkerLeader(this.isLeader);
    if (this.isLeader && !this.loopsStarted) {
      this.loopsStarted = true;
      const control: PollControl = {
        isLeader: () => this.isLeader,
        signal: this.abortController.signal,
      };
      for (const reg of this.handlers.values()) {
        void this.poller.runLoop(reg, control);
      }
    }
    if (!this.abortController.signal.aborted) {
      this.leaseTimer = setTimeout(
        () => void this.tryBecomeLeader(),
        this.leaseRenewIntervalMs,
      );
    }
  }
}
