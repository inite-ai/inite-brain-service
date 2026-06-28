import { Injectable, Logger, Optional } from '@nestjs/common';
import { ApiKeyService } from '../auth/api-key.service';
import { JobClaimService } from '../jobs/job-claim.service';
import type { JobType } from '../jobs/job-run.service';
import {
  WorkerLoopService,
  type JobContext,
  type JobHandler,
} from '../jobs/worker-loop.service';

/**
 * CompactionQueueService — the queue/dispatch plumbing for compaction.
 *
 * Owns the worker-loop handler registration and the per-tenant cron
 * enqueue, plus the queue-mode flag and the known-tenant list. The
 * actual compaction work lives in CompactionRunnerService; the cron
 * cadence + metrics live in CompactionService. Splitting this out keeps
 * each compaction class's injected-dep list ≤3.
 *
 * claim / workerLoop are optional — single-process test contexts run the
 * legacy in-line path without a queue.
 */
@Injectable()
export class CompactionQueueService {
  private readonly logger = new Logger(CompactionQueueService.name);

  constructor(
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
  ) {}

  /** True when the queue path is wired (claim available). */
  get hasClaim(): boolean {
    return !!this.claim;
  }

  knownTenants(): string[] {
    return this.apiKeys.knownCompanyIds();
  }

  queueModeEnabled(): boolean {
    return (process.env.JOBS_QUEUE_MODE ?? 'enqueue') === 'enqueue';
  }

  /**
   * Register a job handler with the worker loop. No-op when the worker
   * loop isn't wired (single-process tests).
   */
  register(
    jobType: JobType,
    handler: (ctx: JobContext) => Promise<Record<string, unknown>>,
    opts: { ttlSeconds: number; maxAttempts: number },
  ): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(jobType, handler as JobHandler, opts);
  }

  /** Enqueue one compaction row per known tenant (idempotent per day). */
  async enqueueAllTenants(jobType: JobType): Promise<{ enqueued: number }> {
    const tenants = this.apiKeys.knownCompanyIds();
    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of tenants) {
      try {
        const { created } = await this.claim!.enqueue({
          jobType,
          companyId,
          triggeredBy: 'cron',
          dedupKey: `${jobType}_${today}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue ${jobType} for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Compaction cron enqueued ${enqueued}/${tenants.length} tenant job(s) for ${today}`,
    );
    return { enqueued };
  }
}
