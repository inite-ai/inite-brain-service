import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { LRUCache } from '../common/lru-cache';
import { envFlagEnabled } from '../common/env-validation';

export interface MemoryStats {
  entities: number;
  factsActive: number;
  factsCompeting: number;
  factsRetracted: number;
  /**
   * Tenant-wide community count. Communities are graph clusters built
   * over the WHOLE tenant entity graph — community_node carries no
   * userId (migrations 0036 / 0055), so a per-user community count is
   * not derivable. For a userId-pinned (end-user) caller it is reported
   * as an explicit `null` — "not applicable for this scope" — which the
   * Usage UI renders as "N/A", distinct from a genuine measured `0`.
   * Surfacing the tenant-global figure on a personal page would be a
   * metadata leak (audit F3), so the real count is present (a number)
   * only for M2M / admin callers.
   */
  communities?: number | null;
  /** Facts recorded (learned) in the last 7 days. */
  factsLast7d: number;
  asOf: string;
}

/**
 * StatsService — cheap per-company memory counts for the end-user
 * "Usage" surface. One batched round-trip of COUNT aggregates, run on a
 * scope-bound connection. (NOTE, R4 audit: the DB-level PII PERMISSIONS
 * fence does not currently fire for the system `brain_caller` user — these
 * are non-PII aggregate counts so it is immaterial here; the app-layer
 * filter is the effective PII barrier on value-bearing reads.)
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
 *
 * Per-user scope (audit F3): a userId-pinned caller (end-user token)
 * sees only its OWN + tenant-global counts, never the tenant aggregate.
 * knowledge_entity / knowledge_fact carry userId (migration 0055) and
 * are filtered `(userId IS NONE OR userId = $userId)` — the same read
 * predicate the fact/entity/search lanes use; community_node has no
 * userId (tenant-wide clusters) so its count is omitted for such a
 * caller. The 0088 views are tenant-wide GROUP-ALL materializations (no
 * userId partition), so a userId-pinned caller always takes the live,
 * user-scoped path below regardless of the flag; only M2M / admin
 * callers read the views. The LRU key carries the pinned userId.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  /** 30s cache: several COUNT aggregates over the largest tables per
   *  dashboard page-load is pure waste — counts move slower than users
   *  refresh. Keyed by tenant for an M2M / admin caller, and by
   *  tenant+userId for a userId-pinned caller (audit F3) so one user's
   *  cached overview is never served to another user or to the
   *  tenant-wide caller. */
  private readonly cache = new LRUCache<string, { stats: MemoryStats; at: number }>(500);
  private static readonly CACHE_TTL_MS = 30_000;
  /** Tenants whose view-read failure has already been logged (log once). */
  private readonly viewFallbackLogged = new Set<string>();

  constructor(private readonly surreal: SurrealService) {}

  async overview(
    companyId: string,
    scopes: readonly string[],
    userId?: string,
  ): Promise<MemoryStats> {
    const nowMs = Date.now();
    // The 0088 views are tenant-wide GROUP-ALL materializations with no
    // userId partition, so they can only serve a caller WITHOUT a pinned
    // userId. A userId-pinned (end-user) caller always takes the live,
    // user-scoped path below — regardless of STATS_VIEWS_ENABLED — so it
    // never reads the tenant aggregate (audit F3).
    if (userId === undefined && envFlagEnabled(process.env.STATS_VIEWS_ENABLED)) {
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
    // Cache key carries the pinned userId so a per-user overview is never
    // served to another user or to the tenant-wide M2M caller (and vice
    // versa). companyId is validated `[A-Za-z0-9_-]+` (withScopedCompany)
    // and cannot contain a space, so the first space unambiguously
    // delimits companyId from userId — a tenant-only key can never
    // collide with a per-user key, whatever the userId contains.
    const cacheKey = userId === undefined ? companyId : `${companyId} ${userId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && nowMs - cached.at < StatsService.CACHE_TTL_MS) {
      return cached.stats;
    }
    const weekAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.surreal.withScopedCompany(companyId, scopes, async (db) => {
      if (userId === undefined) {
        // Tenant-wide (M2M / admin) — byte-identical to the pre-F3 query.
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
        this.cache.set(cacheKey, { stats, at: nowMs });
        return stats;
      }
      // Per-user (audit F3): every user-scopable table (knowledge_entity /
      // knowledge_fact carry userId — migration 0055) is filtered to the
      // caller's own rows PLUS tenant-global rows via the SAME read
      // predicate the fact/entity/search lanes use. `gate` is a constant
      // literal; $userId is a bound parameter. community_node has no
      // userId, so its tenant-wide count is reported as an explicit null
      // ("N/A" in the UI) rather than a misleading 0 or the leaked
      // tenant-global figure.
      const gate = '(userId IS NONE OR userId = $userId)';
      const sql = `
        SELECT count() AS c FROM knowledge_entity WHERE ${gate} GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'active' AND ${gate} GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'competing' AND ${gate} GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'retracted' AND ${gate} GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE recordedAt > type::datetime($weekAgoIso) AND ${gate} GROUP ALL;
      `;
      const res = (await db.query<unknown[]>(sql, { weekAgoIso, userId })) as unknown[];
      const stats: MemoryStats = {
        entities: countOf(res[0]),
        factsActive: countOf(res[1]),
        factsCompeting: countOf(res[2]),
        factsRetracted: countOf(res[3]),
        // Explicit "not applicable for a per-user scope" — never 0, never
        // the tenant-global figure. The Usage UI renders null as "N/A".
        communities: null,
        factsLast7d: countOf(res[4]),
        asOf: new Date(nowMs).toISOString(),
      };
      this.cache.set(cacheKey, { stats, at: nowMs });
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
