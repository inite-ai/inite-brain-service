import { Injectable, Logger, Optional } from '@nestjs/common';
import { ApiKeyService } from '../../auth/api-key.service';
import { JobClaimService } from '../../jobs/job-claim.service';
import type { JobType } from '../../jobs/job-run.service';
import {
  WorkerLoopService,
  type JobContext,
  type JobHandler,
} from '../../jobs/worker-loop.service';

/**
 * CalibrationRefitQueueService — queue/dispatch plumbing for the nightly
 * refits. Owns the worker-loop handler registration, the single
 * cross-tenant cron enqueue, the queue-mode flag, and the known-tenant
 * list. The refit work lives in CalibrationRefitRunnerService; the cron
 * cadence + job-run tracking live in CalibrationRefitService.
 */
@Injectable()
export class CalibrationRefitQueueService {
  private readonly logger = new Logger(CalibrationRefitQueueService.name);

  constructor(
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
  ) {}

  get hasClaim(): boolean {
    return !!this.claim;
  }

  queueModeEnabled(): boolean {
    return (process.env.JOBS_QUEUE_MODE ?? 'enqueue') === 'enqueue';
  }

  register(
    jobType: JobType,
    handler: (ctx: JobContext) => Promise<Record<string, unknown>>,
    opts: { ttlSeconds: number; maxAttempts: number },
  ): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(jobType, handler as JobHandler, opts);
  }

  /**
   * Enqueue a single cross-tenant refit row (the runner walks every
   * tenant internally). Uses the first known tenant as the row's home.
   */
  async enqueueRefit(jobType: JobType): Promise<{ enqueued: boolean }> {
    const hostTenant = this.apiKeys.knownCompanyIds()[0];
    if (!hostTenant) {
      this.logger.warn(`enqueue ${jobType} skipped — no known tenants`);
      return { enqueued: false };
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      const { created } = await this.claim!.enqueue({
        jobType,
        companyId: hostTenant,
        triggeredBy: 'cron',
        dedupKey: `${jobType}_${today}`,
      });
      this.logger.log(
        `${jobType} cron ${created ? 'enqueued' : 'collapsed (already enqueued)'} for ${today}`,
      );
      return { enqueued: created };
    } catch (e) {
      this.logger.warn(`enqueue ${jobType} failed: ${(e as Error).message}`);
      return { enqueued: false };
    }
  }
}
