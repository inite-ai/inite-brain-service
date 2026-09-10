import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedLeaseGuard, noteUnguarded } from '../common/distributed-lease.guard';
import { MetricsService } from '../metrics/metrics.service';
import { type JobContext } from '../jobs/worker-loop.service';
import { CompactionRunnerService } from './compaction-runner.service';
import { CompactionQueueService } from './compaction-queue.service';
import { PromotionRunnerService } from './promotion-runner.service';
import { CompactionStats } from './compaction.types';

export { SUMMARY_GENERATOR } from './compaction.types';
export type { CompactionStats } from './compaction.types';

/** Lock key of the inline (non-queue) daily pass. */
const INLINE_LOCK_KEY = 'compaction_all';
/** The inline pass walks every tenant serially; well past queue mode's 15 min per tenant. */
const INLINE_LEASE_TTL_SECONDS = 60 * 60;

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
 *   Inline fallback (queue mode off, or no claim service): run the tenant
 *   fan-out inline under the distributed lease guard, with the in-flight
 *   bool as the process-local reentrancy layer. Without the guard (unit
 *   fixtures) the pass runs bare, which only a single replica may.
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

  // Fourth dep is the episodic→semantic promotion pass (Wave 3) — it
  // rides the compaction cron/queue rather than owning its own.
  // eslint-disable-next-line max-params
  constructor(
    private readonly runner: CompactionRunnerService,
    private readonly queue: CompactionQueueService,
    private readonly promotion: PromotionRunnerService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly guard?: DistributedLeaseGuard,
  ) {}

  onModuleInit(): void {
    this.queue.register(
      'compaction',
      async (ctx: JobContext) => {
        const stats = await this.compactCompany(ctx.companyId);
        return {
          factsCompacted: stats.factsCompacted,
          summariesCreated: stats.summariesCreated,
          bytesFreed: stats.bytesFreed,
          factsPromoted: stats.factsPromoted ?? 0,
          groupsPromoted: stats.groupsPromoted ?? 0,
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
    const run = this.guard
      ? await this.guard.run(
          INLINE_LOCK_KEY,
          () => this.compactAllInline(),
          INLINE_LEASE_TTL_SECONDS,
        )
      : await this.compactAllInline();
    if (run === null) {
      this.logger.warn('compaction cron skipped — another run holds the lease');
      return [];
    }
    return run;
  }

  /** The inline pass under the process-local single-flight flag. */
  private async compactAllInline(): Promise<CompactionStats[]> {
    if (!this.guard) noteUnguarded(this.logger, 'compaction');
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
    for (const s of stats) {
      this.metrics?.countCompacted(s.factsCompacted);
      await this.promoteInto(s);
    }
    return stats;
  }

  /** Compact one tenant inline (admin manual trigger / dreams pipeline). */
  async compactCompany(companyId: string): Promise<CompactionStats> {
    const stats = await this.runner.compactCompany(companyId);
    this.metrics?.countCompacted(stats.factsCompacted);
    await this.promoteInto(stats);
    return stats;
  }

  /** Episodic→semantic promotion leg — folds its counters into the
   *  tenant's compaction stats. Never fails the compaction pass. */
  private async promoteInto(stats: CompactionStats): Promise<void> {
    if (!this.promotion.isEnabled()) return;
    try {
      const promo = await this.promotion.promoteCompany(stats.companyId);
      stats.factsPromoted = promo.factsPromoted;
      stats.groupsPromoted = promo.groupsPromoted;
      this.metrics?.countPromoted(promo.factsPromoted);
    } catch (e) {
      this.logger.warn(`promotion failed for ${stats.companyId}: ${(e as Error).message}`);
    }
  }
}
