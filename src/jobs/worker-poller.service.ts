import { Injectable, Logger, Optional } from '@nestjs/common';
import { withSpan } from '../common/tracing';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService, type JobClaim } from './job-claim.service';
import { JobDispatcherService } from './job-dispatcher.service';
import type { JobType } from './job-run.service';
import type { PollControl, RegisteredHandler } from './worker-loop.types';

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

/** Per-jobType concurrency limits resolved from the environment. */
interface ConcurrencyLimits {
  /** Max in-flight dispatches for this jobType (≥1). */
  maxConcurrent: number;
  /** Max in-flight dispatches per (jobType, tenant) (≥1). */
  tenantMax: number;
  /** Max in-flight dispatches across ALL jobTypes in this process; 0 = uncapped. */
  globalMax: number;
}

/** Parse an integer env var; undefined when unset or not a valid integer. */
function readIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  return parseInt(raw.trim(), 10);
}

/**
 * WorkerPollerService — the per-jobType polling loop with weighted-fair
 * tenant ordering. Claims the next job for a fair tenant and hands it to
 * JobDispatcherService. Leadership + the pod-shutdown signal are supplied
 * by WorkerLoopService via the PollControl handle. Owns the recent-claim
 * fairness counters (+ their decay). Splitting it out keeps every worker
 * class ≤3 deps. Poll cadences read from the environment.
 *
 * Concurrency: WORKER_LOOP_MAX_CONCURRENT_<JOBTYPE> (fallback
 * WORKER_LOOP_MAX_CONCURRENT, default 1) bounds in-flight dispatches per
 * jobType; WORKER_LOOP_TENANT_MAX_CONCURRENT (default 1) bounds them per
 * (jobType, tenant) so extra slots go to OTHER tenants first;
 * WORKER_LOOP_GLOBAL_MAX_CONCURRENT (default 0 = uncapped) bounds them
 * across every loop in this process. With everything at the defaults the
 * loop takes the original strictly-serial code path.
 */
@Injectable()
export class WorkerPollerService {
  private readonly logger = new Logger(WorkerPollerService.name);
  private readonly pollIntervalMs = parseInt(
    process.env.WORKER_LOOP_POLL_MS ?? '1000',
    10,
  );
  private readonly emptyPollBackoffMs = parseInt(
    process.env.WORKER_LOOP_EMPTY_BACKOFF_MS ?? '5000',
    10,
  );
  private readonly recentClaims = new Map<string, number>();
  private decayTimer: NodeJS.Timeout | null = null;
  /** In-flight dispatch count per `${jobType}::${companyId}` (tenant cap). */
  private readonly inFlightByTenant = new Map<string, number>();
  /** In-flight dispatches across all runLoops in this process (global cap). */
  private globalInFlight = 0;

  constructor(
    private readonly dispatcher: JobDispatcherService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly apiKeys?: ApiKeyService,
  ) {}

  get hasClaim(): boolean {
    return !!this.claim;
  }

  /** Decay recent-claim counters so a quiet tenant regains weight. */
  startDecay(): void {
    if (this.decayTimer) return;
    this.decayTimer = setInterval(() => {
      for (const [key, n] of this.recentClaims) {
        const next = Math.floor(n * 0.5);
        if (next <= 0) this.recentClaims.delete(key);
        else this.recentClaims.set(key, next);
      }
    }, 30_000);
    if (this.decayTimer.unref) this.decayTimer.unref();
  }

  stopDecay(): void {
    if (this.decayTimer) clearInterval(this.decayTimer);
    this.decayTimer = null;
  }

  /**
   * Per-jobType polling loop. Runs while the pod holds the lease (per
   * control.isLeader). On empty queue across all tenants, backs off.
   *
   * With the concurrency knobs at their defaults (per-type max 1, no
   * global cap) this delegates to the original strictly-serial loop;
   * otherwise to the bounded-concurrency variant.
   */
  async runLoop(reg: RegisteredHandler, control: PollControl): Promise<void> {
    const limits = this.concurrencyLimits(reg.jobType);
    if (limits.maxConcurrent <= 1 && limits.globalMax === 0) {
      return this.runLoopSerial(reg, control);
    }
    return this.runLoopConcurrent(reg, control, limits);
  }

  /** The original one-at-a-time loop: claim → await dispatch → sleep. */
  private async runLoopSerial(
    reg: RegisteredHandler,
    control: PollControl,
  ): Promise<void> {
    this.logger.log(`Poll loop started for jobType=${reg.jobType}`);
    while (!control.signal.aborted) {
      if (!control.isLeader()) {
        // Lost leadership mid-loop; sleep until renew tick reinstates us.
        await sleep(this.pollIntervalMs, control.signal);
        continue;
      }
      let claimed: JobClaim | null = null;
      try {
        const tenants = this.sampleByFairness(
          reg.jobType,
          this.apiKeys?.knownCompanyIds() ?? [],
        );
        for (const companyId of tenants) {
          if (control.signal.aborted || !control.isLeader()) break;
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
        await withSpan('jobs.dispatch', () =>
          this.dispatcher.dispatch(claimed!, reg, control.signal),
        );
      } else {
        await sleep(this.emptyPollBackoffMs, control.signal);
      }
      // Always yield a beat so a tight loop can't starve the event loop.
      await sleep(this.pollIntervalMs, control.signal);
    }
    this.logger.log(`Poll loop stopped for jobType=${reg.jobType}`);
  }

  /**
   * Bounded-concurrency loop. Keeps up to limits.maxConcurrent dispatches
   * in flight for this jobType, at most limits.tenantMax per tenant (so a
   * slow tenant can't hog every slot — extra slots go to other tenants),
   * and never exceeds limits.globalMax across all loops in this process.
   * When saturated it waits for a slot or the next poll tick, whichever
   * comes first. On abort it drains in-flight dispatches before returning.
   */
  private async runLoopConcurrent(
    reg: RegisteredHandler,
    control: PollControl,
    limits: ConcurrencyLimits,
  ): Promise<void> {
    this.logger.log(
      `Poll loop started for jobType=${reg.jobType} ` +
        `(maxConcurrent=${limits.maxConcurrent}, tenantMax=${limits.tenantMax}, ` +
        `globalMax=${limits.globalMax || 'uncapped'})`,
    );
    const inFlight = new Set<Promise<void>>();
    while (!control.signal.aborted) {
      if (!control.isLeader()) {
        // Lost leadership mid-loop; sleep until renew tick reinstates us.
        await sleep(this.pollIntervalMs, control.signal);
        continue;
      }
      if (this.saturated(inFlight.size, limits)) {
        // All slots busy — wake on the first finished dispatch or the
        // poll tick (the tick matters for the global cap: a slot may
        // free up in ANOTHER jobType's loop).
        await Promise.race([
          ...inFlight,
          sleep(this.pollIntervalMs, control.signal),
        ]);
        continue;
      }
      // Reserve the global slot BEFORE the claim await: the saturation
      // check above and this increment run in the same synchronous block,
      // so two loops can't both pass the cap and then both claim.
      this.globalInFlight += 1;
      const claimed = await this.claimForEligibleTenant(reg, control, limits);
      if (claimed) {
        this.trackDispatch({ claimed, reg, control, inFlight });
      } else {
        this.globalInFlight -= 1;
        // Empty queue (for eligible tenants) — back off, but wake early
        // if a dispatch finishes: that can free a tenant-cap slot whose
        // tenant still has pending jobs.
        await Promise.race([
          ...inFlight,
          sleep(this.emptyPollBackoffMs, control.signal),
        ]);
      }
      // Always yield a beat so a tight loop can't starve the event loop.
      await sleep(this.pollIntervalMs, control.signal);
    }
    if (inFlight.size > 0) {
      // Dispatcher propagates the shutdown abort into handlers and owns
      // the terminal writes; we only wait for them to settle.
      await Promise.allSettled([...inFlight]);
    }
    this.logger.log(`Poll loop stopped for jobType=${reg.jobType}`);
  }

  /** True when the per-type or global concurrency cap leaves no free slot. */
  private saturated(inFlightSize: number, limits: ConcurrencyLimits): boolean {
    return (
      inFlightSize >= limits.maxConcurrent ||
      (limits.globalMax > 0 && this.globalInFlight >= limits.globalMax)
    );
  }

  /**
   * One claim cycle over tenants that still have a free (jobType, tenant)
   * slot. Tenants at their cap are filtered out BEFORE fairness sampling
   * so the weighted ordering only ranks tenants we could actually serve.
   */
  private async claimForEligibleTenant(
    reg: RegisteredHandler,
    control: PollControl,
    limits: ConcurrencyLimits,
  ): Promise<JobClaim | null> {
    try {
      const eligible = (this.apiKeys?.knownCompanyIds() ?? []).filter(
        (companyId) =>
          (this.inFlightByTenant.get(`${reg.jobType}::${companyId}`) ?? 0) <
          limits.tenantMax,
      );
      const tenants = this.sampleByFairness(reg.jobType, eligible);
      for (const companyId of tenants) {
        if (control.signal.aborted || !control.isLeader()) break;
        const claimed = await this.claim!.claimNext({
          companyId,
          jobType: reg.jobType,
          ttlSeconds: reg.ttlSeconds,
        });
        if (claimed) {
          this.recordClaim(reg.jobType, companyId);
          return claimed;
        }
      }
    } catch (e) {
      this.logger.warn(
        `claim cycle (${reg.jobType}) failed: ${(e as Error).message}`,
      );
    }
    return null;
  }

  /**
   * Fire a dispatch without awaiting it inline. The dispatcher owns lease
   * renewal and the terminal complete/fail/cancelled writes, so errors are
   * swallowed here; bookkeeping (in-flight set + tenant/global counters)
   * is released in finally. The GLOBAL counter was already incremented by
   * the caller (slot reservation) — only the tenant counter is taken here.
   */
  private trackDispatch(args: {
    claimed: JobClaim;
    reg: RegisteredHandler;
    control: PollControl;
    inFlight: Set<Promise<void>>;
  }): void {
    const { claimed, reg, control, inFlight } = args;
    const tenantKey = `${reg.jobType}::${claimed.companyId}`;
    this.inFlightByTenant.set(
      tenantKey,
      (this.inFlightByTenant.get(tenantKey) ?? 0) + 1,
    );
    const p: Promise<void> = withSpan('jobs.dispatch', () =>
      this.dispatcher.dispatch(claimed, reg, control.signal),
    )
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(p);
        const n = (this.inFlightByTenant.get(tenantKey) ?? 1) - 1;
        if (n <= 0) this.inFlightByTenant.delete(tenantKey);
        else this.inFlightByTenant.set(tenantKey, n);
        this.globalInFlight = Math.max(0, this.globalInFlight - 1);
        control.onInFlight?.(reg.jobType, inFlight.size);
      });
    inFlight.add(p);
    control.onInFlight?.(reg.jobType, inFlight.size);
  }

  /**
   * Resolve the concurrency knobs for one jobType. Read at loop start
   * (loops spin up once per leadership acquisition), not per cycle.
   */
  private concurrencyLimits(jobType: JobType): ConcurrencyLimits {
    const suffix = jobType.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const perType = readIntEnv(`WORKER_LOOP_MAX_CONCURRENT_${suffix}`);
    const fallback = readIntEnv('WORKER_LOOP_MAX_CONCURRENT');
    return {
      maxConcurrent: Math.max(1, perType ?? fallback ?? 1),
      tenantMax: Math.max(
        1,
        readIntEnv('WORKER_LOOP_TENANT_MAX_CONCURRENT') ?? 1,
      ),
      globalMax: readIntEnv('WORKER_LOOP_GLOBAL_MAX_CONCURRENT') ?? 0,
    };
  }

  /**
   * Weighted-random tenant ordering (Efraimidis-Spirakis). Lower
   * recentClaims → higher weight → more likely tried first this cycle.
   * Public for test-time isolation.
   */
  sampleByFairness(jobType: JobType, tenants: readonly string[]): string[] {
    if (tenants.length <= 1) return [...tenants];
    const keyed = tenants.map((companyId) => {
      const n = this.recentClaims.get(`${jobType}::${companyId}`) ?? 0;
      const weight = 1 / (1 + n);
      const u = Math.random();
      const key = Math.pow(u, 1 / weight);
      return { companyId, key };
    });
    keyed.sort((a, b) => b.key - a.key);
    return keyed.map((k) => k.companyId);
  }

  /** Bump the recent-claim counter — bounded to 64. */
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
