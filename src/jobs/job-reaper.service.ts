import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from './job-claim.service';
import { mapWithLimit } from '../common/parallel';

export interface ReapResult {
  requeued: number;
  failed: number;
  tenants: number;
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
    this.maxAttempts = parseInt(
      config.get<string>('JOB_RUN_MAX_ATTEMPTS', '3') ?? '3',
      10,
    );
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
    const tenants = this.apiKeys.knownCompanyIds();
    let requeued = 0;
    let failed = 0;
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
        return null;
      },
    });
    if (requeued > 0 || failed > 0) {
      this.logger.log(
        `Zombie reap: requeued=${requeued}, failed=${failed} across ${tenants.length} tenant(s)`,
      );
    }
    return { requeued, failed, tenants: tenants.length };
  }
}
