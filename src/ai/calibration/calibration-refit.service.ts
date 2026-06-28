import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CalibrationRefitRunnerService } from './calibration-refit-runner.service';
import { CalibrationRefitQueueService } from './calibration-refit-queue.service';
import {
  CalibrationRefitJobService,
  type RefitTrigger,
} from './calibration-refit-job.service';

/**
 * Phase 3.5 — nightly refit + source-trust recalculation (orchestration).
 *
 *   1. source-trust refit (03:42 UTC) — learned agreement rates.
 *   2. calibration refit (03:51 UTC) — PAV-fit + hot-reload.
 *
 * This class owns only the cron cadence + queue-vs-inline routing. The
 * refit math lives in CalibrationRefitRunnerService, the queue/dispatch
 * in CalibrationRefitQueueService, and the inline lease + job_run
 * tracking in CalibrationRefitJobService — so each class keeps ≤3 deps.
 *
 * Queue mode enqueues a single cross-tenant row (the runner walks every
 * tenant); inline mode runs under the distributed lease with job_run
 * tracking. Schedule offsets sit inside the shared daily quiet window.
 */
@Injectable()
export class CalibrationRefitService implements OnModuleInit {
  private readonly logger = new Logger(CalibrationRefitService.name);
  private readonly enabled =
    (process.env.CALIBRATION_NIGHTLY_REFIT ?? 'true').toLowerCase() !== 'false';

  constructor(
    private readonly runner: CalibrationRefitRunnerService,
    private readonly queue: CalibrationRefitQueueService,
    private readonly jobs: CalibrationRefitJobService,
  ) {}

  onModuleInit(): void {
    this.queue.register(
      'source_trust_refit',
      async () => {
        // Cross-tenant single-row job — the refit walks all tenants.
        const { count } = await this.runner.refitSourceTrust();
        return { upserted: count };
      },
      { ttlSeconds: 600, maxAttempts: 2 },
    );
    this.queue.register(
      'calibration_refit',
      async () => {
        const { count } = await this.runner.refitCalibration();
        return { sampleCount: count };
      },
      { ttlSeconds: 600, maxAttempts: 2 },
    );
  }

  /** Cron — source-trust refit at 03:42 UTC. */
  @Cron('42 3 * * *', { timeZone: 'UTC' })
  async refitSourceTrustDaily(): Promise<number | { enqueued: boolean }> {
    if (!this.enabled) return 0;
    if (this.queue.hasClaim && this.queue.queueModeEnabled()) {
      return this.queue.enqueueRefit('source_trust_refit');
    }
    return this.refitSourceTrust();
  }

  /** Cron — calibration refit at 03:51 UTC. */
  @Cron('51 3 * * *', { timeZone: 'UTC' })
  async refitCalibrationDaily(): Promise<number | { enqueued: boolean }> {
    if (!this.enabled) return 0;
    if (this.queue.hasClaim && this.queue.queueModeEnabled()) {
      return this.queue.enqueueRefit('calibration_refit');
    }
    return this.refitCalibration();
  }

  /** Inline source-trust refit (manual trigger / non-queue mode). */
  async refitSourceTrust(trigger?: RefitTrigger): Promise<number> {
    return this.jobs.runTracked({
      jobType: 'source_trust_refit',
      guardKey: 'refit_source_trust',
      trigger,
      fn: (onProgress) => this.runner.refitSourceTrust(onProgress),
    });
  }

  /** Inline calibration refit (manual trigger / non-queue mode). */
  async refitCalibration(trigger?: RefitTrigger): Promise<number> {
    return this.jobs.runTracked({
      jobType: 'calibration_refit',
      guardKey: 'refit_calibration',
      trigger,
      fn: (onProgress) => this.runner.refitCalibration(onProgress),
    });
  }

  /** Operator-facing list of persisted calibration_table versions. */
  async listVersions(): ReturnType<CalibrationRefitRunnerService['listVersions']> {
    return this.runner.listVersions();
  }
}
