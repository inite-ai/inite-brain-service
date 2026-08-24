import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';

export interface MemoryStats {
  entities: number;
  factsActive: number;
  factsCompeting: number;
  factsRetracted: number;
  communities: number;
  /** Facts recorded (learned) in the last 7 days. */
  factsLast7d: number;
  asOf: string;
}

/**
 * StatsService — cheap per-company memory counts for the end-user
 * "Usage" surface. One batched round-trip of COUNT aggregates, run on a
 * scope-bound connection so PII permissions still apply.
 *
 * Two read paths behind STATS_VIEWS_ENABLED (default off):
 *   - off: live GROUP aggregates + 30s LRU (pre-0088 behavior).
 *   - on: the 0088 computed tables (stats_entity_total /
 *     stats_fact_by_status / stats_community_total) — SurrealDB keeps
 *     them incrementally up to date on source writes, so the view IS
 *     the cache and the LRU is deliberately bypassed. factsLast7d is a
 *     moving window and stays a live count in both paths. A failing
 *     view read (pre-migration tenant) logs once per tenant and falls
 *     back to the live path.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  /** 30s per-tenant cache: six COUNT aggregates over the largest tables
   *  per dashboard page-load is pure waste — counts move slower than
   *  users refresh. Keyed by tenant only (the counts are not
   *  scope-dependent; the scoped connection matters for row reads, not
   *  aggregates over statuses). */
  private readonly cache = new LRUCache<string, { stats: MemoryStats; at: number }>(500);
  private static readonly CACHE_TTL_MS = 30_000;
  /** Tenants whose view-read failure has already been logged (log once). */
  private readonly viewFallbackLogged = new Set<string>();

  constructor(private readonly surreal: SurrealService) {}

  async overview(companyId: string, scopes: readonly string[]): Promise<MemoryStats> {
    const nowMs = Date.now();
    if (envFlagEnabled(process.env.STATS_VIEWS_ENABLED)) {
      try {
        return await this.overviewFromViews(companyId, scopes, nowMs);
      } catch (err) {
        if (!this.viewFallbackLogged.has(companyId)) {
          this.viewFallbackLogged.add(companyId);
          this.logger.warn(
            `stats views unavailable for ${companyId} (pre-0088 tenant?), ` +
              `falling back to live counts: ${(err as Error).message}`,
          );
        }
        // fall through to the live path below
      }
    }
    const cached = this.cache.get(companyId);
    if (cached && nowMs - cached.at < StatsService.CACHE_TTL_MS) {
      return cached.stats;
    }
    const weekAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const sql = `
        SELECT count() AS c FROM knowledge_entity GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'active' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'competing' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'retracted' GROUP ALL;
        SELECT count() AS c FROM community_node GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE recordedAt > type::datetime($weekAgoIso) GROUP ALL;
      `;
      const res = (await db.query<unknown[]>(sql, { weekAgoIso })) as unknown[];
      const stats: MemoryStats = {
        entities: countOf(res[0]),
        factsActive: countOf(res[1]),
        factsCompeting: countOf(res[2]),
        factsRetracted: countOf(res[3]),
        communities: countOf(res[4]),
        factsLast7d: countOf(res[5]),
        asOf: new Date(nowMs).toISOString(),
      };
      this.cache.set(companyId, { stats, at: nowMs });
      return stats;
    });
  }

  /**
   * View-backed read: three rollup-table fetches + the one live moving
   * window. No LRU on this path — the computed tables are already the
   * cached counts, and skipping the LRU means the flag flip is visible
   * immediately instead of after a TTL.
   */
  private async overviewFromViews(
    companyId: string,
    scopes: readonly string[],
    nowMs: number,
  ): Promise<MemoryStats> {
    const weekAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      const sql = `
        SELECT n FROM stats_entity_total;
        SELECT n, status FROM stats_fact_by_status;
        SELECT n FROM stats_community_total;
        SELECT count() AS c FROM knowledge_fact WHERE recordedAt > type::datetime($weekAgoIso) GROUP ALL;
      `;
      const res = (await db.query<unknown[]>(sql, { weekAgoIso })) as unknown[];
      const byStatus = statusCountsOf(res[1]);
      return {
        entities: viewCountOf(res[0]),
        factsActive: byStatus.get('active') ?? 0,
        factsCompeting: byStatus.get('competing') ?? 0,
        factsRetracted: byStatus.get('retracted') ?? 0,
        communities: viewCountOf(res[2]),
        factsLast7d: countOf(res[3]),
        asOf: new Date(nowMs).toISOString(),
      };
    });
  }
}

function countOf(stmtResult: unknown): number {
  if (!Array.isArray(stmtResult) || stmtResult.length === 0) return 0;
  const first = stmtResult[0] as { c?: unknown };
  return typeof first?.c === 'number' ? first.c : 0;
}

/** Single-row GROUP ALL view: absent row (empty source) reads as 0. */
function viewCountOf(stmtResult: unknown): number {
  if (!Array.isArray(stmtResult) || stmtResult.length === 0) return 0;
  const first = stmtResult[0] as { n?: unknown };
  return typeof first?.n === 'number' ? first.n : 0;
}

/** GROUP BY status view rows → status → n. Missing groups read as 0. */
function statusCountsOf(stmtResult: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(stmtResult)) return out;
  for (const row of stmtResult as Array<{ n?: unknown; status?: unknown }>) {
    if (typeof row?.status === 'string' && typeof row?.n === 'number') {
      out.set(row.status, row.n);
    }
  }
  return out;
}
