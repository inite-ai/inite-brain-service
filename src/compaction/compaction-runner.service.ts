import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService, dbCreate } from '../db/surreal.service';
import {
  ConcatSummaryGenerator,
  FactToSummarize,
  SummaryGenerator,
} from './summary-generator';
import {
  CandidateFactRow,
  CompactionStats,
  SUMMARY_GENERATOR,
} from './compaction.types';

/**
 * CompactionRunnerService — the retention engine.
 *
 * Owns the actual compaction work for a tenant: SELECT old facts past
 * the hot-retention window, optionally roll them up into summary facts
 * via the SummaryGenerator, then mark + drop embeddings on the
 * originals. Parameterised by tenant id / tenant list so it carries no
 * apiKeys dependency — the cron cadence, queue dispatch, tenant fan-out
 * source, and metrics live in CompactionService, which delegates here.
 * Splitting the engine out keeps each compaction class's injected-dep
 * list ≤3.
 *
 * compactCompany returns stats; the caller emits metrics. Idempotent: a
 * compacted row stays compacted.
 */
@Injectable()
export class CompactionRunnerService {
  private readonly logger = new Logger(CompactionRunnerService.name);
  private readonly hotRetentionDays: number;
  private readonly summariesEnabled: boolean;
  private readonly summaryGenerator: SummaryGenerator;

  constructor(
    private readonly surreal: SurrealService,
    config: ConfigService,
    @Optional() @Inject(SUMMARY_GENERATOR) injectedGenerator?: SummaryGenerator,
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

  /**
   * Compact every tenant in the list. Errors per-tenant are logged; one
   * bad tenant must not stop the rest from getting compacted.
   */
  async compactAll(tenants: string[]): Promise<CompactionStats[]> {
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
