import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MetricsService } from '../metrics/metrics.service';
import { type JobContext } from '../jobs/worker-loop.service';
import { CompactionRunnerService } from './compaction-runner.service';
import { CompactionQueueService } from './compaction-queue.service';
import { CompactionStats } from './compaction.types';

export { SUMMARY_GENERATOR } from './compaction.types';
export type { CompactionStats } from './compaction.types';

/**
 * CompactionService — daily retention pass per spec.
 *
 * Two-stage retention model (hot tier + warm summary tier) implemented
 * by CompactionRunnerService. This class is the cron/dispatch
 * orchestration shell:
 *
 *   Queue mode (JobClaimService wired): the cron enqueues one row per
 *   known tenant; WorkerLoopService dispatches each to the handler
 *   registered in onModuleInit. CAS handles multi-pod races.
 *
 *   Legacy fallback (no claim service — single-process tests): keep the
 *   original in-flight bool guard and run the tenant fan-out inline.
 *
 * Metrics (countCompacted) are emitted here per tenant; the runner stays
 * metrics-free so it's a pure engine. Splitting the runner (engine) and
 * queue (dispatch) out keeps every compaction class's injected-dep list
 * ≤3.
 */
@Injectable()
export class CompactionService implements OnModuleInit {
  private readonly logger = new Logger(CompactionService.name);
  private compactionInFlight = false;

  constructor(
    private readonly runner: CompactionRunnerService,
    private readonly queue: CompactionQueueService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    this.queue.register(
      'compaction',
      async (ctx: JobContext) => {
        const stats = await this.runner.compactCompany(ctx.companyId);
        this.metrics?.countCompacted(stats.factsCompacted);
        return {
          factsCompacted: stats.factsCompacted,
          summariesCreated: stats.summariesCreated,
          bytesFreed: stats.bytesFreed,
        };
      },
      // Compaction can take several minutes on large tenants; ttl 15min
      // gives the renew loop room while staying short enough that a
      // crashed worker's row is reclaimed within one cycle of the
      // zombie reaper.
      { ttlSeconds: 900, maxAttempts: 2 },
    );
  }

  /**
   * Cron entry — daily at 03:17 UTC, off-peak for most regions.
   *
   * Reentrancy: compaction rewrites fact status in place; two concurrent
   * passes would re-compact already-compacted rows and double-bill
   * summary generation. The dedupKey + UNIQUE(jobType, dedupKey) index
   * makes the cron-time enqueue idempotent across leader transitions on
   * the same day.
   */
  @Cron('17 3 * * *', { timeZone: 'UTC' })
  async runDaily(): Promise<CompactionStats[] | { enqueued: number }> {
    if (this.queue.hasClaim && this.queue.queueModeEnabled()) {
      return this.queue.enqueueAllTenants('compaction');
    }
    if (this.compactionInFlight) {
      this.logger.warn('compaction cron skipped — previous run still in flight');
      return [];
    }
    this.compactionInFlight = true;
    try {
      return await this.compactAll();
    } finally {
      this.compactionInFlight = false;
    }
  }

  /**
   * Compact every known tenant inline, emitting per-tenant metrics.
   * Delegates the work to the runner; kept here as the public entry the
   * admin endpoints + dreams pipeline already call.
   */
  async compactAll(): Promise<CompactionStats[]> {
    const stats = await this.runner.compactAll(this.queue.knownTenants());
    for (const s of stats) this.metrics?.countCompacted(s.factsCompacted);
    return stats;
  }

  /** Compact one tenant inline (admin manual trigger / dreams pipeline). */
  async compactCompany(companyId: string): Promise<CompactionStats> {
    const stats = await this.runner.compactCompany(companyId);
    this.metrics?.countCompacted(stats.factsCompacted);
    return stats;
  }
}
