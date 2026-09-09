import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from './job-claim.service';
import { mapWithLimit } from '../common/parallel';

export interface ReapResult {
  requeued: number;
  failed: number;
  tenants: number;
  /**
   * Tenants whose reap threw and reclaimed nothing. Separate from `failed`,
   * which counts jobs the reaper deliberately gave up on — this counts
   * tenants the reaper could not act on at all. Without it, a sweep that
   * reclaimed nothing because it worked and a sweep that reclaimed nothing
   * because it was broken return the identical value.
   */
  errored: number;
}

/**
 * JobReaperService — the zombie-reap engine.
 *
 * Sweeps job_run rows whose status='running' AND leaseUntil<now() across
 * every known tenant: under maxAttempts → requeue with backoff;
 * at-or-above → fail terminally. Owns only the reap mechanics + its
 * tunables (maxAttempts, backoffBaseMs). The cron cadence, leader
 * election, and re-entrancy guard live in LeaseManagerService, which
 * calls reap() once it has confirmed it's the leader. Splitting this out
 * keeps both classes' injected-dep lists ≤3 and makes the reap logic
 * testable without the cron/lease scaffolding.
 */
@Injectable()
export class JobReaperService {
  private readonly logger = new Logger(JobReaperService.name);
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;

  constructor(
    config: ConfigService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly apiKeys?: ApiKeyService,
  ) {
    this.maxAttempts = parseInt(config.get<string>('JOB_RUN_MAX_ATTEMPTS', '3') ?? '3', 10);
    this.backoffBaseMs = parseInt(
      config.get<string>('JOB_RUN_BACKOFF_BASE_MS', '30000') ?? '30000',
      10,
    );
  }

  /**
   * Reap expired claims across all known tenants. Returns null when the
   * claim/apiKeys collaborators aren't wired (standalone contexts).
   */
  async reap(): Promise<ReapResult | null> {
    if (!this.claim || !this.apiKeys) return null;
    const tenants = this.apiKeys.fanOutRoster();
    let requeued = 0;
    let failed = 0;
    const erroredTenants: string[] = [];
    // Parallel fan-out bounded under the SURREALDB_POOL_SIZE budget
    // — each reapZombies call holds one root pool conn for its
    // SELECT+UPDATE pair. Cap at 4 so a saturated reap can't fully
    // drain the pool from caller-facing requests.
    await mapWithLimit({
      items: tenants,
      concurrency: 4,
      fn: async (companyId) => {
        const result = await this.claim!.reapZombies({
          companyId,
          maxAttempts: this.maxAttempts,
          backoffBaseMs: this.backoffBaseMs,
        });
        requeued += result.requeued;
        failed += result.failed;
        if (result.errored !== undefined) erroredTenants.push(companyId);
        return null;
      },
    });
    if (requeued > 0 || failed > 0) {
      this.logger.log(
        `Zombie reap: requeued=${requeued}, failed=${failed} across ${tenants.length} tenant(s)`,
      );
    }
    // A sweep where every tenant threw used to be silent here: the success
    // log is gated on requeued/failed, and both are 0 when nothing ran. Now
    // a broken sweep says so on its own, once per pass, naming how many
    // tenants it could not reap at all.
    if (erroredTenants.length > 0) {
      this.logger.error(
        `Zombie reap could not run for ${erroredTenants.length} of ${tenants.length} tenant(s): ` +
          `${erroredTenants.slice(0, 5).join(', ')}` +
          `${erroredTenants.length > 5 ? ', …' : ''} — expired leases are NOT being reclaimed`,
      );
    }
    return { requeued, failed, tenants: tenants.length, errored: erroredTenants.length };
  }
}
