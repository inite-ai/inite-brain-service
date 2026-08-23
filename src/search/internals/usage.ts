import type { Logger } from '@nestjs/common';
import { StringRecordId, type Surreal } from 'surrealdb';
import type { SurrealService } from '../../db/surreal.service';
import type { FactRow } from './types';

/**
 * Usage-based reinforcement (fact_usage, migration 0053) — the search
 * pipeline's two touchpoints:
 *
 *   * enrichWithUsage  — read side: attach lastReadAt to fused candidates
 *     so scoring can restart the decay clock at the most recent retrieval
 *     (gated by SEARCH_USAGE_DECAY_ENABLED at the call site).
 *   * recordFactUsage  — write side: fire-and-forget stamp of the facts a
 *     search actually surfaced (gated by SEARCH_USAGE_RECORDING_ENABLED).
 *
 * Both soft-fail: usage is a ranking refinement, never a reason for a
 * search to error or slow down.
 */

/** Max facts stamped per search — bounds the write amplification. */
const RECORD_CAP = 100;

/**
 * What the read-path fold-in attaches. Both flags gate ONE batched query
 * that already reads both columns, so the two consumers stay decoupled:
 *   * lastReadAt (SEARCH_USAGE_DECAY_ENABLED) restarts the decay clock —
 *     attaching it changes scoring, so it stays gated on decay alone;
 *   * readCount (SEARCH_USAGE_RANKING_ENABLED, G8) feeds the usage
 *     ranking factor — attached only when ranking is on, so decay-off
 *     ranking-off callers are byte-identical.
 */
export interface UsageAttach {
  lastReadAt: boolean;
  readCount: boolean;
}

/**
 * Batch-fetch usage rows for the fused candidate set and attach the
 * requested fields in place. One indexed query for the whole set; rows
 * the pipeline injects later (edge expansion / backfill) stay
 * unenriched — they are supplementary context, not primary relevance.
 */
export async function enrichWithUsage(opts: {
  db: Surreal;
  logger: Logger;
  rows: FactRow[];
  attach?: UsageAttach;
}): Promise<number> {
  const { db, logger, rows } = opts;
  const attach = opts.attach ?? { lastReadAt: true, readCount: false };
  if (rows.length === 0 || (!attach.lastReadAt && !attach.readCount)) return 0;
  try {
    const ids = rows.map((r) => new StringRecordId(String(r.id)));
    const [usageRows] = await db.query<
      [Array<{ factId: unknown; lastReadAt: Date | string; readCount: number }>]
    >(`SELECT factId, lastReadAt, readCount FROM fact_usage WHERE factId INSIDE $ids`, { ids });
    const byFactId = new Map<string, { lastReadAt: string; readCount: number }>();
    for (const u of (usageRows as Array<{
      factId: unknown;
      lastReadAt: Date | string;
      readCount: number;
    }>) ?? []) {
      byFactId.set(String(u.factId), {
        lastReadAt:
          u.lastReadAt instanceof Date ? u.lastReadAt.toISOString() : String(u.lastReadAt),
        readCount: typeof u.readCount === 'number' ? u.readCount : 0,
      });
    }
    let enriched = 0;
    for (const row of rows) {
      const usage = byFactId.get(String(row.id));
      if (!usage) continue;
      if (attach.lastReadAt) row.lastReadAt = usage.lastReadAt;
      if (attach.readCount) row.readCount = usage.readCount;
      enriched++;
    }
    return enriched;
  } catch (e) {
    logger.warn(`usage enrichment failed: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Stamp the surfaced facts, detached from the request: a fresh root-pool
 * connection (the caller's scoped connection returns to the pool when the
 * request ends — a detached write must not borrow it), one INSERT with
 * ON DUPLICATE KEY UPDATE riding the UNIQUE factId index.
 */
export function recordFactUsage(opts: {
  surreal: SurrealService;
  logger: Logger;
  companyId: string;
  factIds: string[];
}): void {
  const ids = [...new Set(opts.factIds)].slice(0, RECORD_CAP);
  if (ids.length === 0) return;
  void opts.surreal
    .withCompany(opts.companyId, async (db) => {
      const rows = ids.map((id) => ({
        factId: new StringRecordId(id),
        readCount: 1,
        lastReadAt: new Date(),
      }));
      await db.query(
        `INSERT INTO fact_usage $rows
           ON DUPLICATE KEY UPDATE readCount += 1, lastReadAt = time::now()`,
        { rows },
      );
    })
    .catch((e: Error) => {
      opts.logger.warn(`usage recording failed for ${opts.companyId}: ${e.message}`);
    });
}
