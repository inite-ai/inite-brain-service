import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService, dbCreate } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { JobClaimService } from '../jobs/job-claim.service';
import {
  WorkerLoopService,
  type JobContext,
} from '../jobs/worker-loop.service';
import {
  ConcatSummaryGenerator,
  FactToSummarize,
  SummaryGenerator,
} from './summary-generator';

export const SUMMARY_GENERATOR = Symbol('SUMMARY_GENERATOR');

export interface CompactionStats {
  companyId: string;
  factsCompacted: number;
  summariesCreated: number;
  bytesFreed: number;
}

/**
 * CompactionService — daily retention pass per spec.
 *
 * Two-stage retention model:
 *
 *   1. **Hot tier (default 90d).** Raw facts are searchable, embeddings
 *      live in storage, full text is indexed. This is what most queries hit.
 *   2. **Warm summary tier.** Facts older than the hot window are marked
 *      `status = 'compacted'`, lose their embedding (storage saving), and
 *      — when there are ≥ 2 of them under the same (entityId, predicate) —
 *      get rolled up into one **summary** fact via `SummaryGenerator`.
 *      The summary carries `derivedFrom: [oldFactIds]` so the audit trail
 *      stays intact, and it's searchable on its own embedding.
 *
 * The summary leg is opt-in via `COMPACTION_SUMMARIES=true`. Without it,
 * compaction is a pure mark-and-drop pass (the original behaviour). With
 * it, the warm tier becomes genuinely searchable through one synthetic
 * fact per (entity, predicate) cluster.
 *
 * The default generator is `ConcatSummaryGenerator` (no LLM, just
 * chronological stitching). Verticals can inject their own
 * `SummaryGenerator` provider under the `SUMMARY_GENERATOR` token to
 * use an LLM-backed rollup.
 *
 * Idempotent: a compacted row stays compacted; re-running on the same
 * window finds zero new candidates.
 */
@Injectable()
export class CompactionService implements OnModuleInit {
  private readonly logger = new Logger(CompactionService.name);
  private readonly hotRetentionDays: number;
  private readonly summariesEnabled: boolean;
  private readonly summaryGenerator: SummaryGenerator;

  constructor(
    private readonly surreal: SurrealService,
    private readonly apiKeys: ApiKeyService,
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() @Inject(SUMMARY_GENERATOR) injectedGenerator?: SummaryGenerator,
    @Optional() private readonly claim?: JobClaimService,
    @Optional() private readonly workerLoop?: WorkerLoopService,
  ) {
    this.hotRetentionDays = parseInt(
      config.get<string>('COMPACTION_HOT_RETENTION_DAYS', '90'),
      10,
    );
    if (!Number.isFinite(this.hotRetentionDays) || this.hotRetentionDays < 1) {
      throw new Error('COMPACTION_HOT_RETENTION_DAYS must be a positive integer');
    }
    this.summariesEnabled =
      config.get<string>('COMPACTION_SUMMARIES', 'false').toLowerCase() === 'true';
    this.summaryGenerator = injectedGenerator ?? new ConcatSummaryGenerator();
    this.logger.log(
      `Compaction config: retention=${this.hotRetentionDays}d, summaries=${this.summariesEnabled}, generator=${this.summaryGenerator.constructor.name}`,
    );
  }

  onModuleInit(): void {
    if (!this.workerLoop) return;
    this.workerLoop.register(
      'compaction',
      async (ctx: JobContext) => {
        const stats = await this.compactCompany(ctx.companyId);
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
   * Queue mode (JobClaimService wired): enqueue one row per known
   * tenant. WorkerLoopService dispatches; CAS handles multi-pod races.
   *
   * Legacy fallback (no claim service — single-process tests): keep
   * the original in-flight bool guard so callers don't regress.
   *
   * Reentrancy: compaction rewrites fact status in place; two
   * concurrent passes would re-compact already-compacted rows and
   * double-bill summary generation. The dedupKey + UNIQUE(jobType,
   * dedupKey) index makes the cron-time enqueue idempotent across
   * leader transitions on the same day.
   */
  @Cron('17 3 * * *', { timeZone: 'UTC' })
  async runDaily(): Promise<CompactionStats[] | { enqueued: number }> {
    if (this.claim && this.queueModeEnabled()) {
      return this.enqueueDailyForAllTenants();
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

  private queueModeEnabled(): boolean {
    return (
      (this.config.get<string>('JOBS_QUEUE_MODE', 'enqueue') ?? 'enqueue') ===
      'enqueue'
    );
  }

  private async enqueueDailyForAllTenants(): Promise<{ enqueued: number }> {
    const tenants = this.apiKeys.knownCompanyIds();
    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const companyId of tenants) {
      try {
        const { created } = await this.claim!.enqueue({
          jobType: 'compaction',
          companyId,
          triggeredBy: 'cron',
          dedupKey: `compaction_${today}`,
        });
        if (created) enqueued++;
      } catch (e) {
        this.logger.warn(
          `enqueue compaction for ${companyId} failed: ${(e as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Compaction cron enqueued ${enqueued}/${tenants.length} tenant job(s) for ${today}`,
    );
    return { enqueued };
  }

  private compactionInFlight = false;

  /**
   * Compact every known tenant. Errors per-tenant are logged; one bad
   * tenant must not stop the rest from getting compacted.
   */
  async compactAll(): Promise<CompactionStats[]> {
    const tenants = this.apiKeys.knownCompanyIds();
    this.logger.log(`Compaction starting — ${tenants.length} tenant(s)`);
    const results: CompactionStats[] = [];
    for (const companyId of tenants) {
      try {
        const stats = await this.compactCompany(companyId);
        results.push(stats);
      } catch (e) {
        this.logger.error(
          `Compaction failed for ${companyId}: ${(e as Error).message}`,
        );
      }
    }
    const total = results.reduce((acc, r) => acc + r.factsCompacted, 0);
    const summaries = results.reduce((acc, r) => acc + r.summariesCreated, 0);
    this.logger.log(
      `Compaction done — ${total} fact(s) compacted, ${summaries} summary fact(s) created across ${results.length} tenant(s)`,
    );
    return results;
  }

  /**
   * Compact one tenant. Pipeline:
   *   1. SELECT old facts (carrying embeddings) past the retention window.
   *   2. (Optional) Group by (entityId, predicate) and create a summary
   *      fact per group of ≥ 2.
   *   3. UPDATE old facts: status = 'compacted', embedding = NONE.
   */
  async compactCompany(companyId: string): Promise<CompactionStats> {
    const cutoff = new Date(
      Date.now() - this.hotRetentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return this.surreal.withCompany(companyId, async (db) => {
      // Step 1: pull candidate facts with their bodies, so the summarizer
      // has something to work with. We bound by 1000/run to avoid one
      // tenant dominating the cron — anything past that gets compacted
      // on the next cycle.
      const [factRows] = await db.query<[CandidateFactRow[]]>(
        `SELECT id, entityId, predicate, object, validFrom, validUntil, confidence
           FROM knowledge_fact
           WHERE status != 'compacted'
             AND embedding != NONE
             AND ((validUntil != NONE AND validUntil < d$cutoff)
                  OR (retractedAt != NONE AND retractedAt < d$cutoff))
           ORDER BY validFrom ASC
           LIMIT 1000`,
        { cutoff },
      );
      const candidates = (factRows ?? []) as CandidateFactRow[];
      if (candidates.length === 0) {
        return { companyId, factsCompacted: 0, summariesCreated: 0, bytesFreed: 0 };
      }

      // Step 2: optional summary rollup
      let summariesCreated = 0;
      if (this.summariesEnabled) {
        summariesCreated = await this.createSummaries(db, candidates);
      }

      // Step 3: mark + drop embeddings on the originals
      const ids = candidates.map((c) => String(c.id));
      await db.query(
        `UPDATE knowledge_fact
           SET status = 'compacted', embedding = NONE
           WHERE id INSIDE $ids`,
        { ids },
      );

      const factsCompacted = candidates.length;
      const bytesFreed = factsCompacted * 6 * 1024;
      this.logger.log(
        `Compacted ${factsCompacted} fact(s) in tenant ${companyId} ` +
          `(~${(bytesFreed / 1024 / 1024).toFixed(1)} MiB freed, ${summariesCreated} summary fact(s))`,
      );
      this.metrics?.countCompacted(factsCompacted);
      return { companyId, factsCompacted, summariesCreated, bytesFreed };
    });
  }

  /**
   * Group candidate facts by (entityId, predicate), then for each group
   * with ≥ 2 facts call the SummaryGenerator and CREATE a summary fact
   * pointing at the originals via `derivedFrom`. Returns the count of
   * summaries created.
   */
  private async createSummaries(
     
    db: any,
    candidates: CandidateFactRow[],
  ): Promise<number> {
    const groups = new Map<string, CandidateFactRow[]>();
    for (const c of candidates) {
      const key = `${c.entityId}::${c.predicate}`;
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }

    let created = 0;
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) =>
        a.validFrom < b.validFrom ? -1 : 1,
      );
      const summaryText = await this.summaryGenerator.generate(
        sorted.map((g) => ({
          factId: String(g.id),
          predicate: g.predicate,
          object: g.object,
          validFrom: g.validFrom,
          validUntil: g.validUntil ?? undefined,
          confidence: g.confidence,
        }) satisfies FactToSummarize),
      );
      if (!summaryText) continue;

      const earliest = sorted[0].validFrom;
      const latest = sorted[sorted.length - 1].validUntil ?? sorted[sorted.length - 1].validFrom;
      const meanConfidence =
        sorted.reduce((acc, g) => acc + g.confidence, 0) / sorted.length;

      await dbCreate(db, 'knowledge_fact', {
        entityId: sorted[0].entityId,
        predicate: `summary_${sorted[0].predicate}`,
        object: summaryText,
        confidence: meanConfidence,
        validFrom: earliest,
        validUntil: latest,
        source: { kind: 'compaction-summary' },
        derivedFrom: sorted.map((g) => g.id),
        status: 'active',
      });
      created++;
    }
    return created;
  }
}

interface CandidateFactRow {
  id: unknown;
  entityId: unknown;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string | null;
  confidence: number;
}
