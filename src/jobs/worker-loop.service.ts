import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService, type JobClaim } from './job-claim.service';
import { LeaderLeaseService } from './leader-lease.service';
import { JobWorkerPool } from './job-worker-pool.service';
import { MetricsService } from '../metrics/metrics.service';
import type { JobType } from './job-run.service';

export interface JobContext {
  runId: string;
  jobType: JobType;
  companyId: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  /**
   * Aborts on: (a) handler exceeded leaseUntil and lost the claim;
   * (b) operator flipped cancelRequested via /admin/jobs/:id/cancel;
   * (c) pod shutdown. Handlers MUST pass this into long-running
   * primitives (fetch / OpenAI client / Surreal queries) so cancel
   * actually terminates the work instead of just flagging the row.
   */
  abortSignal: AbortSignal;
  /** For structured logs: pod identity that won the claim. */
  workerId: string;
}

export type JobHandler = (
  ctx: JobContext,
) => Promise<Record<string, unknown> | void>;

interface RegisteredHandler {
  jobType: JobType;
  handler: JobHandler;
  /** Per-claim lease TTL — should be longer than typical handler runtime. */
  ttlSeconds: number;
  /** Max attempts before terminal-fail. */
  maxAttempts: number;
  /**
   * Route to JobWorkerPool instead of running in-thread. Required
   * companion: workerModule pointing at a CommonJS module that
   * exports `run(input): Promise<output>`.
   */
  cpuBound?: boolean;
  workerModule?: string;
}

/**
 * WorkerLoopService — drains the `job_run` queue across known tenants.
 *
 * Lifecycle:
 *   1. Modules register handlers in their onModuleInit:
 *        workerLoop.register('dreams', dreamsHandler, { ttlSeconds: 600 })
 *   2. After all handlers register, this service acquires the
 *      `worker_loop` leader_lease and starts one polling loop per
 *      registered jobType.
 *   3. Each poll iterates the known tenants in random order and tries
 *      claimNext(companyId, jobType). On a hit, dispatches with a
 *      renew interval that doubles as the cross-pod cancel poll.
 *   4. On shutdown: signal AbortController, release the leader_lease,
 *      let any in-flight handler observe the abort and exit.
 *
 * One pod runs the loop at a time. The other pods sit idle on a
 * try-acquire-every-N-seconds tick, ready to take over within ~ttl
 * when the leader dies. CAS on claimNext is still the ultimate
 * defence — even if two pods both thought they were leader for a
 * heartbeat-window, only one wins the CAS.
 *
 * Phase J ships ONE worker pod runs ALL job types. Phase K will lift
 * CPU-bound handlers (BGE-M3 reindex, multi-pass extractor) into a
 * worker_threads pool; the JobDispatcher will choose per-handler
 * based on a `cpuBound: true` flag in the registration.
 *
 * Tenant iteration is random per poll to give weak fairness — a
 * noisy tenant with a backlog can't monopolise claim attention.
 * Per-tenant weighted-shuffle (Inngest pattern) is Phase K.
 */
@Injectable()
export class WorkerLoopService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerLoopService.name);
  private readonly handlers = new Map<JobType, RegisteredHandler>();
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly emptyPollBackoffMs: number;
  private readonly abortController = new AbortController();
  private leaseTimer: NodeJS.Timeout | null = null;
  private isLeader = false;
  private loopsStarted = false;
  /**
   * Sliding-window per-tenant recent-claim counters keyed by
   * `${jobType}::${companyId}`. The pollLoop bumps the counter on
   * each successful claim AND naturally decays them via the
   * scheduleClaimDecay loop. Used by sampleByFairness to give an
   * underclaimed tenant a higher chance of being tried first in
   * the next poll cycle — bounded, simple counter rather than a
   * full priority queue.
   */
  private readonly recentClaims = new Map<string, number>();
  private decayTimer: NodeJS.Timeout | null = null;

  constructor(
    config: ConfigService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly lease?: LeaderLeaseService,
    @Optional() private readonly apiKeys?: ApiKeyService,
    @Optional() @Inject('WORKER_LOOP_NOW') private readonly now?: () => number,
    @Optional() private readonly workerPool?: JobWorkerPool,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.enabled =
      (config.get<string>('WORKER_LOOP_ENABLED', '1') ?? '1') !== '0';
    this.pollIntervalMs = parseInt(
      config.get<string>('WORKER_LOOP_POLL_MS', '1000') ?? '1000',
      10,
    );
    this.emptyPollBackoffMs = parseInt(
      config.get<string>('WORKER_LOOP_EMPTY_BACKOFF_MS', '5000') ?? '5000',
      10,
    );
    // Renew/acquire the leader_lease every 30s. ttl=90s gives a
    // crashed leader's lease ~90s to expire — short enough for fast
    // failover, long enough to survive GC pauses.
    this.leaseRenewIntervalMs = parseInt(
      config.get<string>('WORKER_LOOP_LEASE_RENEW_MS', '30000') ?? '30000',
      10,
    );
  }

  /**
   * Register a handler for a job type. Called from module-owner
   * services' onModuleInit so we have a complete registry by the
   * time the leader loop spins up.
   */
  register(
    jobType: JobType,
    handler: JobHandler,
    opts?: {
      ttlSeconds?: number;
      maxAttempts?: number;
      /**
       * Set true to dispatch via JobWorkerPool. Required companion:
       * workerModule — absolute path to a CommonJS file that
       * `export run(input): Promise<output>`. The pool's worker
       * thread dynamic-imports it once per pool slot and caches.
       *
       * The handler argument still runs as a fallback when the pool
       * is disabled (JOB_WORKER_POOL_SIZE=0) or all workers crashed
       * — keep it functionally equivalent so dev / test mode without
       * the pool isn't a different code path.
       */
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
    if (!this.claim) {
      this.logger.warn('JobClaimService not available — worker loop inert');
      return;
    }
    // Defer the first lease acquisition by one tick so module-owners
    // get a chance to register their handlers in their own onModuleInit
    // before we start polling for jobs we can't dispatch.
    this.leaseTimer = setTimeout(
      () => void this.tryBecomeLeader(),
      this.leaseRenewIntervalMs / 6, // 5s by default
    );
    // Decay recent-claim counters every 30s so a tenant that's been
    // quiet for one window gets its weight back, but a tenant that's
    // been hot needs ~2 windows of silence to fully reset. Multiplier
    // 0.5 chosen so the exponential decay halves the count per tick.
    this.decayTimer = setInterval(() => {
      for (const [key, n] of this.recentClaims) {
        const next = Math.floor(n * 0.5);
        if (next <= 0) this.recentClaims.delete(key);
        else this.recentClaims.set(key, next);
      }
    }, 30_000);
    // Don't keep the event loop alive just for decay.
    if (this.decayTimer.unref) this.decayTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    if (this.decayTimer) clearInterval(this.decayTimer);
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

  /**
   * Acquire-or-renew the worker_loop lease, then spin up per-jobType
   * polling loops once. Re-runs every leaseRenewIntervalMs.
   */
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
      for (const reg of this.handlers.values()) {
        void this.pollLoop(reg);
      }
    }
    // Re-schedule the next lease check.
    if (!this.abortController.signal.aborted) {
      this.leaseTimer = setTimeout(
        () => void this.tryBecomeLeader(),
        this.leaseRenewIntervalMs,
      );
    }
  }

  /**
   * Per-jobType polling loop. Runs while this pod holds the lease.
   *
   * Tenant iteration: sampleByFairness() gives a weighted random
   * order where weight = 1/(1+recentClaims[tenant]). A tenant that's
   * just landed N successful claims gets weight 1/(N+1) for the next
   * cycle, so a hot tenant can't monopolise the loop — quiet
   * neighbours get tried first. Mirrors the "weighted-shuffle peek"
   * pattern Inngest uses for queue fairness, scaled down to per-pod
   * in-memory counters (we only need fairness within ONE leader
   * pod's view; multi-pod scale is gated by leader_lease anyway).
   *
   * On empty queue across all tenants, back off to
   * emptyPollBackoffMs so we don't hammer Surreal.
   */
  private async pollLoop(reg: RegisteredHandler): Promise<void> {
    this.logger.log(`Poll loop started for jobType=${reg.jobType}`);
    while (!this.abortController.signal.aborted) {
      if (!this.isLeader) {
        // Lost leadership mid-loop; sleep until renew tick reinstates us.
        await sleep(this.leaseRenewIntervalMs, this.abortController.signal);
        continue;
      }
      let claimed: JobClaim | null = null;
      try {
        const tenants = this.sampleByFairness(
          reg.jobType,
          this.apiKeys?.knownCompanyIds() ?? [],
        );
        for (const companyId of tenants) {
          if (this.abortController.signal.aborted || !this.isLeader) break;
          claimed = await this.claim!.claimNext({
            companyId,
            jobType: reg.jobType,
            ttlSeconds: reg.ttlSeconds,
          });
          if (claimed) {
            this.recordClaim(reg.jobType, companyId);
            break;
          }
        }
      } catch (e) {
        this.logger.warn(
          `claim cycle (${reg.jobType}) failed: ${(e as Error).message}`,
        );
      }
      if (claimed) {
        await this.dispatch(claimed, reg);
      } else {
        await sleep(this.emptyPollBackoffMs, this.abortController.signal);
      }
      // Always yield a beat so a tight loop can't starve the event loop.
      await sleep(this.pollIntervalMs, this.abortController.signal);
    }
    this.logger.log(`Poll loop stopped for jobType=${reg.jobType}`);
  }

  /**
   * Run a single claim. Owns the renew interval (which doubles as the
   * cross-pod cancel poll), wraps the handler in an AbortController,
   * and routes the outcome to complete / fail / cancelled.
   *
   * OTel: extract the producer-side traceparent injected at enqueue
   * (when present) and run the whole dispatch inside that context so
   * the consumer span links back. With OTEL_ENABLED=0 the API surface
   * is a no-op tracer and the wrap costs essentially nothing.
   */
  private async dispatch(
    claim: JobClaim,
    reg: RegisteredHandler,
  ): Promise<void> {
    const parentCtx = claim.traceparent
      ? propagation.extract(context.active(), {
          traceparent: claim.traceparent,
        })
      : context.active();
    return context.with(parentCtx, () => this.dispatchInner(claim, reg));
  }

  private async dispatchInner(
    claim: JobClaim,
    reg: RegisteredHandler,
  ): Promise<void> {
    const tracer = trace.getTracer('inite-brain-service');
    const span = tracer.startSpan(`jobs.process ${claim.jobType}`, {
      attributes: {
        'messaging.system': 'surrealdb',
        'messaging.operation': 'process',
        'messaging.destination.name': claim.jobType,
        'messaging.destination.kind': 'queue',
        'messaging.message.id': claim.runId,
        'job.companyId': claim.companyId,
        'job.attempts': claim.attempts,
        'job.workerId': this.claim!.identity(),
        'job.cpuBound': reg.cpuBound === true,
      },
    });
    try {
      await context.with(trace.setSpan(context.active(), span), () =>
        this.dispatchBody(claim, reg, span),
      );
    } finally {
      span.end();
    }
  }

  private async dispatchBody(
    claim: JobClaim,
    reg: RegisteredHandler,
    consumerSpan: ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>,
  ): Promise<void> {
    const handlerAbort = new AbortController();
    const startedAt = this.now?.() ?? Date.now();
    // Mirrors the span's `job.outcome`. Defaults to 'failed' so an
    // unexpected throw before any branch is counted as a failure, not lost.
    let outcome: 'succeeded' | 'failed' | 'cancelled' | 'lost_claim' = 'failed';
    // Pod shutdown propagates into the handler.
    const onShutdown = () => handlerAbort.abort(new Error('pod_shutdown'));
    this.abortController.signal.addEventListener('abort', onShutdown, {
      once: true,
    });
    // Renew every ttl/3. The renew result tells us if the row was
    // reaped out from under us OR if an operator requested cancel.
    let cancelRequested = false;
    let lostClaim = false;
    const renewIntervalMs = Math.max(
      1000,
      Math.floor((reg.ttlSeconds * 1000) / 3),
    );
    const renewTimer = setInterval(() => {
      void (async () => {
        const r = await this.claim!.renew({
          companyId: claim.companyId,
          recordId: claim.recordId,
          ttlSeconds: reg.ttlSeconds,
        });
        if (!r.stillOwned) {
          lostClaim = true;
          handlerAbort.abort(new Error('lost_claim'));
        } else if (r.cancelRequested && !cancelRequested) {
          cancelRequested = true;
          handlerAbort.abort(new Error('cancel_requested'));
        }
      })();
    }, renewIntervalMs);
    try {
      const ctx = {
        runId: claim.runId,
        jobType: claim.jobType,
        companyId: claim.companyId,
        payload: claim.payload,
        attempts: claim.attempts,
        abortSignal: handlerAbort.signal,
        workerId: this.claim!.identity(),
      };
      // CPU-bound path: hand off to JobWorkerPool. The worker thread
      // receives only the serialisable subset of ctx — abortSignal /
      // workerId stay in-process and surface to the handler as a
      // cooperative cancel marker via an extra check after the
      // postMessage completes.
      const result =
        reg.cpuBound && reg.workerModule && this.workerPool?.enabled()
          ? await this.workerPool.run(reg.workerModule, {
              runId: ctx.runId,
              jobType: ctx.jobType,
              companyId: ctx.companyId,
              payload: ctx.payload,
              attempts: ctx.attempts,
              workerId: ctx.workerId,
            })
          : await reg.handler(ctx);
      clearInterval(renewTimer);
      if (cancelRequested) {
        consumerSpan.setAttribute('job.outcome', 'cancelled');
        outcome = 'cancelled';
        await this.claim!.cancelled({
          companyId: claim.companyId,
          recordId: claim.recordId,
          result: (result as Record<string, unknown>) ?? undefined,
        });
      } else if (lostClaim) {
        // Don't write — another worker owns the row now. The
        // duplicate-work cost was already paid; just bail.
        consumerSpan.setAttribute('job.outcome', 'lost_claim');
        outcome = 'lost_claim';
        this.logger.warn(
          `Claim ${claim.runId} lost mid-handler; skipping terminal write`,
        );
      } else {
        consumerSpan.setAttribute('job.outcome', 'succeeded');
        outcome = 'succeeded';
        await this.claim!.complete({
          companyId: claim.companyId,
          recordId: claim.recordId,
          result: (result as Record<string, unknown>) ?? undefined,
        });
      }
    } catch (err) {
      clearInterval(renewTimer);
      const e = err as Error;
      consumerSpan.recordException(e);
      if (cancelRequested) {
        consumerSpan.setAttribute('job.outcome', 'cancelled');
        outcome = 'cancelled';
        await this.claim!.cancelled({
          companyId: claim.companyId,
          recordId: claim.recordId,
          result: { reason: 'cancel_requested', message: e.message },
        });
      } else if (lostClaim) {
        consumerSpan.setAttribute('job.outcome', 'lost_claim');
        outcome = 'lost_claim';
        this.logger.warn(
          `Claim ${claim.runId} lost mid-handler (handler threw): ${e.message}`,
        );
      } else {
        consumerSpan.setAttribute('job.outcome', 'failed');
        outcome = 'failed';
        consumerSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        await this.claim!.fail({
          companyId: claim.companyId,
          recordId: claim.recordId,
          attempts: claim.attempts,
          error: { message: e.message, name: e.name },
          requeue: true,
          maxAttempts: reg.maxAttempts,
        });
      }
    } finally {
      this.abortController.signal.removeEventListener('abort', onShutdown);
      const elapsed = ((this.now?.() ?? Date.now()) - startedAt) / 1000;
      this.metrics?.recordJob(claim.jobType, outcome, elapsed);
    }
  }

  /**
   * Weighted-random tenant ordering. Lower recentClaims → higher
   * weight → more likely to be tried first this cycle. Uses Efraimidis-
   * Spirakis weighted sampling: assign each tenant key = u^(1/weight),
   * sort descending. Equivalent to weighted shuffle without
   * replacement, O(n log n).
   *
   * Pure for test-time isolation: extracted to a method so the unit
   * test can drive it with a seeded RNG and assert the ordering
   * actually reflects the recent-claim counters.
   */
  sampleByFairness(jobType: JobType, tenants: readonly string[]): string[] {
    if (tenants.length <= 1) return [...tenants];
    const keyed = tenants.map((companyId) => {
      const n = this.recentClaims.get(`${jobType}::${companyId}`) ?? 0;
      const weight = 1 / (1 + n);
      // u → (0,1); key = u^(1/weight). Higher weight pushes key
      // toward 1 (more likely to win the sort).
      const u = Math.random();
      const key = Math.pow(u, 1 / weight);
      return { companyId, key };
    });
    keyed.sort((a, b) => b.key - a.key);
    return keyed.map((k) => k.companyId);
  }

  /** Bump the recent-claim counter — bounded to 64 so a runaway
   *  tenant doesn't permanently zero its weight (decay still works
   *  but starting from 64 means 7 decay ticks to fully reset, ~3.5
   *  minutes at the default 30s decay cadence). */
  private recordClaim(jobType: JobType, companyId: string): void {
    const key = `${jobType}::${companyId}`;
    const next = Math.min((this.recentClaims.get(key) ?? 0) + 1, 64);
    this.recentClaims.set(key, next);
  }

  /** Read-only — test seam + observability. */
  recentClaimsSnapshot(): Record<string, number> {
    return Object.fromEntries(this.recentClaims);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

