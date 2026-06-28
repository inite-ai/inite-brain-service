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

/**
 * WorkerPollerService — the per-jobType polling loop with weighted-fair
 * tenant ordering. Claims the next job for a fair tenant and hands it to
 * JobDispatcherService. Leadership + the pod-shutdown signal are supplied
 * by WorkerLoopService via the PollControl handle. Owns the recent-claim
 * fairness counters (+ their decay). Splitting it out keeps every worker
 * class ≤3 deps. Poll cadences read from the environment.
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
   */
  async runLoop(reg: RegisteredHandler, control: PollControl): Promise<void> {
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
