import { Injectable, Logger, Optional } from '@nestjs/common';
import { ApiKeyService } from '../../auth/api-key.service';
import { JobRunService } from '../../jobs/job-run.service';
import type { JobType } from '../../jobs/job-run.service';
import { DistributedLeaseGuard } from '../../common/distributed-lease.guard';
import { RefitOutcome, RefitProgress } from './calibration-refit-runner.service';

export interface RefitTrigger {
  triggeredBy?: 'cron' | 'manual' | 'startup';
  triggeredByActor?: string;
}

export interface RunTrackedOptions {
  jobType: JobType;
  /** DistributedLeaseGuard key — distinct from jobType. */
  guardKey: string;
  trigger?: RefitTrigger;
  /** The actual refit, given a per-tenant progress callback. */
  fn: (onProgress: RefitProgress) => Promise<RefitOutcome>;
}

/**
 * CalibrationRefitJobService — wraps an inline refit run with the
 * coordination concerns: a DistributedLeaseGuard (one pod, no overlap)
 * and a job_run row lifecycle (start / per-tenant progress / finish).
 * Both jobs/guard are @Optional so single-process / unit contexts run the
 * bare refit. Extracted so CalibrationRefitService stays at ≤3 deps.
 */
@Injectable()
export class CalibrationRefitJobService {
  private readonly logger = new Logger(CalibrationRefitJobService.name);

  constructor(
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly jobs?: JobRunService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  /** Run the refit under the lease + job-run tracking; returns the count. */
  async runTracked(opts: RunTrackedOptions): Promise<number> {
    const exec = () => this.runWithJobRow(opts);
    const guarded = this.guard
      ? await this.guard.run(opts.guardKey, exec)
      : await exec();
    if (guarded === null) {
      this.logger.warn(`${opts.jobType} skipped — already in flight`);
      return 0;
    }
    return guarded;
  }

  private async runWithJobRow(opts: RunTrackedOptions): Promise<number> {
    const hostTenant = this.apiKeys.knownCompanyIds()[0];
    let jobRow = null as null | Awaited<ReturnType<JobRunService['start']>>;
    if (hostTenant && this.jobs) {
      try {
        jobRow = await this.jobs.start({
          jobType: opts.jobType,
          companyId: hostTenant,
          triggeredBy: opts.trigger?.triggeredBy ?? 'cron',
          triggeredByActor: opts.trigger?.triggeredByActor,
        });
      } catch (e) {
        this.logger.warn(
          `${opts.jobType} job_run start failed: ${(e as Error).message}`,
        );
      }
    }
    try {
      const { count, result } = await opts.fn((detail) => {
        if (jobRow) void this.jobs?.updateProgress(jobRow, detail as never);
      });
      if (jobRow) {
        await this.jobs?.finish(jobRow, { status: 'succeeded', result });
      }
      return count;
    } catch (e) {
      if (jobRow) {
        await this.jobs?.finish(jobRow, {
          status: 'failed',
          error: { message: (e as Error).message, name: (e as Error).name },
        });
      }
      throw e;
    }
  }
}
