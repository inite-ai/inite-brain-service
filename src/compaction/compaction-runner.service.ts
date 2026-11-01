import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import { SurrealService, dbCreate } from '../db/surreal.service';
import { retryOnReadConflict } from '../db/surreal-retry';
import { ReadPinService } from '../episodes/read-pin.service';
import { ConcatSummaryGenerator, FactToSummarize, SummaryGenerator } from './summary-generator';
import { CandidateFactRow, CompactionStats, SUMMARY_GENERATOR } from './compaction.types';
import { envFlagNotDisabled } from '../common/env-validation';
import { summaryEpisodeStampEnabled, supportEdgesEnabled } from '../common/provenance-flags';
import { unionEpisodeIds } from '../common/episode-ids';
import { insertDerivedFromEdges } from './support-edge-mirror';
import { compactionOverridesFor } from './compaction-overrides';

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

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    config: ConfigService,
    @Optional() @Inject(SUMMARY_GENERATOR) injectedGenerator?: SummaryGenerator,
    @Optional() private readonly readPin?: ReadPinService,
  ) {
    this.hotRetentionDays = parseInt(config.get<string>('COMPACTION_HOT_RETENTION_DAYS', '90'), 10);
    if (!Number.isFinite(this.hotRetentionDays) || this.hotRetentionDays < 1) {
      throw new Error('COMPACTION_HOT_RETENTION_DAYS must be a positive integer');
    }
    this.summariesEnabled = envFlagNotDisabled(config.get<string>('COMPACTION_SUMMARIES'));
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
        this.logger.error(`Compaction failed for ${companyId}: ${(e as Error).message}`);
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
    // Per-tenant resolution schedule (COMPACTION_TENANT_OVERRIDES): a
    // tenant entry overrides the process-global hot-retention window;
    // unset = byte-identical to the ctor default.
    const retentionDays =
      compactionOverridesFor(companyId).hotRetentionDays ?? this.hotRetentionDays;
    // A Date param serialises as a native SurrealDB datetime. The previous
    // `d$cutoff` cast + ISO-string param was a 2.x idiom — SurrealDB 3.x
    // fails to PARSE it ("Unexpected token `a parameter`"), which made
    // every compaction pass throw (and log-and-skip) since the 3.1.5
    // upgrade. Caught by the promotion e2e reusing the same idiom.
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Audit W2 #10: compaction used to be version-BLIND. Under a pinned
    // derived world it flipped that world's facts to status='compacted'
    // (invisible) while writing the replacement summary into the legacy
    // namespace the pinned reader never queries — silent memory loss.
    // A world is self-contained: compact inside the live one, stamp the
    // summary with the same version.
    const derivedVersion =
      (await this.readPin?.resolve(companyId)) ?? ReadPinService.bootstrapDefault();
    const versionClause = derivedVersion
      ? 'AND derivedVersion = $derivedVersion'
      : 'AND derivedVersion IS NONE';
    const versionParams = derivedVersion ? { derivedVersion } : {};

    return this.surreal.withCompany(companyId, async (db) => {
      // Step 1: pull candidate facts with their bodies, so the summarizer
      // has something to work with. We bound by 1000/run to avoid one
      // tenant dominating the cron — anything past that gets compacted
      // on the next cycle.
      const [factRows] = await db.query<[CandidateFactRow[]]>(
        `SELECT id, entityId, predicate, object, validFrom, validUntil, confidence, userId,
                retractedAt, scope, source.episodeIds AS eps
           FROM knowledge_fact
           WHERE status != 'compacted'
             AND embedding != NONE
             ${versionClause}
             AND ((validUntil != NONE AND validUntil < $cutoff)
                  OR (retractedAt != NONE AND retractedAt < $cutoff))
           ORDER BY validFrom ASC
           LIMIT 1000`,
        { cutoff, ...versionParams },
      );
      const candidates = (factRows ?? []) as CandidateFactRow[];
      if (candidates.length === 0) {
        return { companyId, factsCompacted: 0, summariesCreated: 0, bytesFreed: 0 };
      }

      // Step 2: optional summary rollup
      let summariesCreated = 0;
      if (this.summariesEnabled) {
        summariesCreated = await this.createSummaries(db, candidates, derivedVersion);
      }

      // Step 3: mark + drop embeddings on the originals. Record-id params,
      // not strings — SurrealDB 3.x no longer coerces string↔record in
      // comparisons, so a string list here matches NOTHING and the whole
      // pass silently no-ops (second half of the same 3.1.5 regression as
      // the `d$cutoff` parse error above).
      // The pass races the serving path's own writes to the same rows (the
      // vector-corpus repair, usage stamps); a commit-time conflict is the
      // store saying "again", and the mark is idempotent, so it retries.
      const ids = candidates.map((c) => new StringRecordId(String(c.id)));
      await retryOnReadConflict(() =>
        db.query(
          `UPDATE knowledge_fact
             SET status = 'compacted', embedding = NONE
             WHERE id INSIDE $ids`,
          { ids },
        ),
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
    db: Surreal,
    candidates: CandidateFactRow[],
    derivedVersion: string | null,
  ): Promise<number> {
    const groups = new Map<string, CandidateFactRow[]>();
    for (const c of candidates) {
      // A retracted fact was never true (bitemporal semantics), so it is
      // compacted but never retold: a summary of it served the retraction
      // back as an active fact to every asOf read inside its window.
      if (c.retractedAt) continue;
      // The whole read scope is part of the rollup key — the user (0055)
      // and the circle and team tags (G6). A summary must never blend a
      // user's facts with the tenant-global timeline, nor a team's facts
      // with everyone's: the summary is a row of its own, read under its
      // own scope.
      const key = `${c.entityId}::${c.predicate}::${c.userId ?? ''}::${scopeKey(c.scope)}`;
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }

    let created = 0;
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
      // The SDK returns datetime columns as Date objects; FactToSummarize
      // (and the concat generator's `.slice`) expect ISO strings — without
      // the normalisation every summary rollup threw a TypeError.
      const summaryText = await this.summaryGenerator.generate(
        sorted.map(
          (g) =>
            ({
              factId: String(g.id),
              predicate: g.predicate,
              object: g.object,
              validFrom: isoOf(g.validFrom),
              validUntil: g.validUntil ? isoOf(g.validUntil) : undefined,
              confidence: g.confidence,
            }) satisfies FactToSummarize,
        ),
      );
      if (!summaryText) continue;

      // group.length ≥ 2 (checked above) ⇒ sorted is non-empty.
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const earliest = first.validFrom;
      const latest = last.validUntil ?? last.validFrom;
      const meanConfidence = sorted.reduce((acc, g) => acc + g.confidence, 0) / sorted.length;

      // Evidence plane (PROVENANCE_SUMMARY_EPISODE_STAMP): union of the
      // members' grounding stamps, member order, capped 64. Flag off →
      // empty union → source byte-identical to today's.
      const episodeIds = summaryEpisodeStampEnabled()
        ? unionEpisodeIds(sorted.map((g) => g.eps))
        : [];

      // A conflict here aborted the whole pass after some summaries had
      // landed and before the originals were marked, so the next run
      // summarised the same group again. A conflicted CREATE wrote
      // nothing, so retrying it cannot duplicate.
      const summary = await retryOnReadConflict(() =>
        dbCreate(db, 'knowledge_fact', {
          entityId: first.entityId,
          predicate: `summary_${first.predicate}`,
          object: summaryText,
          confidence: meanConfidence,
          validFrom: earliest,
          validUntil: latest,
          source: {
            kind: 'compaction-summary',
            ...(episodeIds.length ? { episodeIds } : {}),
          },
          derivedFrom: sorted.map((g) => g.id),
          status: 'active',
          // The summary belongs to the same world as the facts it replaces
          // (audit W2 #10) — otherwise the pinned reader loses both.
          ...(derivedVersion ? { derivedVersion } : {}),
          ...(first.userId ? { userId: first.userId } : {}),
          ...(Array.isArray(first.scope) && first.scope.length > 0
            ? { scope: [...first.scope].map(String) }
            : {}),
        }),
      );
      created++;

      // Typed support graph (PROVENANCE_SUPPORT_EDGES, default off):
      // mirror the EXACT derivedFrom array just written. Best-effort —
      // a mirror failure warns, never aborts the rollup pass. Off ⇒
      // block skipped, the write sequence is byte-identical.
      if (supportEdgesEnabled()) {
        try {
          await insertDerivedFromEdges(db, {
            summaryId: String(summary.id),
            memberIds: sorted.map((g) => String(g.id)),
            writer: 'compaction_runner',
          });
        } catch (e) {
          this.logger.warn(
            `compaction derived_from edge mirror failed (non-fatal): ${(e as Error).message}`,
          );
        }
      }
    }
    return created;
  }
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** A row's scope tags as one order-free key. */
function scopeKey(scope: unknown): string {
  return Array.isArray(scope) ? scope.map(String).sort().join('|') : '';
}
