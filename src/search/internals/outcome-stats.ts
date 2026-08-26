import type { Logger } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import type { FactRow } from './types';

/**
 * Verified-use enrichment (memory_outcome_stat, migration 0107) — the
 * read-side successor to the self-reinforcing fact_usage signals
 * (Brain v2 review gap #7): fact_usage.lastReadAt/readCount grow on
 * every SURFACING, so retrieval alone extends a memory's life. The
 * outcome rollup only moves on VERIFIED use (verifier-supported /
 * user-confirmed), which is what these fields feed:
 *
 *   * lastVerifiedUseAt (profile verifiedUseDecay) — the decay clock
 *     may restart at the last VERIFIED use;
 *   * verifiedUseScore  (profile verifiedUseRanking) — verifiedUseCount
 *     + confirmedCount, feeding the saturating ranking factor
 *     (SEARCH_VERIFIED_USE_BETA).
 *
 * Mirrors enrichWithUsage exactly: ONE batched indexed query for the
 * fused candidate set (subjectId carries a single-field UNIQUE index —
 * INSIDE over it is planner-safe), per-flag attach so decay-only /
 * ranking-only callers stay decoupled, soft-fail (a ranking refinement
 * is never a reason for a search to error or slow down). Rows the
 * pipeline injects later (edge expansion / backfill) stay unenriched —
 * supplementary context, not primary relevance (the usage.ts doctrine).
 */

/**
 * What the read-path fold-in attaches. Both flags gate ONE batched
 * query that already reads all three columns, so the two consumers
 * stay decoupled (the UsageAttach split idiom):
 *   * lastVerifiedUseAt (verifiedUseDecay) changes the decay anchor —
 *     attached only when the decay flag asked for it;
 *   * verifiedUseScore (verifiedUseRanking) feeds the ranking factor —
 *     attached only when ranking is on, so decay-only callers are
 *     byte-identical on the ranking axis.
 */
export interface OutcomeStatsAttach {
  lastVerifiedUseAt: boolean;
  verifiedUseScore: boolean;
}

/**
 * Batch-fetch outcome-stat rows for the fused candidate set and attach
 * the requested fields in place. Returns the number of enriched rows.
 */
export async function enrichWithOutcomeStats(opts: {
  db: Surreal;
  logger: Logger;
  rows: FactRow[];
  attach: OutcomeStatsAttach;
}): Promise<number> {
  const { db, logger, rows, attach } = opts;
  if (rows.length === 0 || (!attach.lastVerifiedUseAt && !attach.verifiedUseScore)) return 0;
  try {
    const ids = rows.map((r) => new StringRecordId(String(r.id)));
    const [statRows] = await db.query<
      [
        Array<{
          subjectId: unknown;
          verifiedUseCount: number;
          confirmedCount: number;
          lastVerifiedUseAt?: Date | string | null;
        }>,
      ]
    >(
      `SELECT subjectId, verifiedUseCount, confirmedCount, lastVerifiedUseAt
         FROM memory_outcome_stat WHERE subjectId INSIDE $ids`,
      { ids },
    );
    const bySubject = new Map<string, { lastVerifiedUseAt?: string; verifiedUseScore: number }>();
    for (const s of (statRows as Array<{
      subjectId: unknown;
      verifiedUseCount: number;
      confirmedCount: number;
      lastVerifiedUseAt?: Date | string | null;
    }>) ?? []) {
      const verified = typeof s.verifiedUseCount === 'number' ? s.verifiedUseCount : 0;
      const confirmed = typeof s.confirmedCount === 'number' ? s.confirmedCount : 0;
      bySubject.set(String(s.subjectId), {
        verifiedUseScore: verified + confirmed,
        ...(s.lastVerifiedUseAt
          ? {
              lastVerifiedUseAt:
                s.lastVerifiedUseAt instanceof Date
                  ? s.lastVerifiedUseAt.toISOString()
                  : String(s.lastVerifiedUseAt),
            }
          : {}),
      });
    }
    let enriched = 0;
    for (const row of rows) {
      const stat = bySubject.get(String(row.id));
      if (!stat) continue;
      if (attach.lastVerifiedUseAt && stat.lastVerifiedUseAt) {
        row.lastVerifiedUseAt = stat.lastVerifiedUseAt;
      }
      if (attach.verifiedUseScore) row.verifiedUseScore = stat.verifiedUseScore;
      enriched++;
    }
    return enriched;
  } catch (e) {
    logger.warn(`outcome-stat enrichment failed: ${(e as Error).message}`);
    return 0;
  }
}
