import { Injectable, Logger, Optional } from '@nestjs/common';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService, queryRows } from '../db/surreal.service';

export interface OperatorActionRow {
  ts: string;
  actor: string;
  scopes: string[];
  method: string;
  path: string;
  status: number;
  durationMs: number;
  query?: Record<string, unknown> | null;
  bodySummary?: Record<string, unknown> | null;
  companyId: string;
}

/** Columns read back from `operator_action`. */
interface OperatorActionDbRow {
  ts: string | Date;
  actor: string;
  scopes?: unknown;
  method: string;
  path: string;
  status: number;
  durationMs?: number;
  query?: Record<string, unknown> | null;
  bodySummary?: Record<string, unknown> | null;
}

/**
 * Storage layer for `operator_action` (migration 0027). Writes are
 * best-effort, fire-and-forget — failure must not block the admin
 * request itself.
 *
 * Reads merge across tenants for the admin UI. Tenant scoping is
 * trivial because the row's actor === companyId of the key.
 */
@Injectable()
export class OperatorActionService {
  private readonly logger = new Logger(OperatorActionService.name);

  constructor(
    @Optional() private readonly surreal?: SurrealService,
    @Optional() private readonly apiKeys?: ApiKeyService,
  ) {}

  /** Fire-and-forget write. Returns void so the caller doesn't await. */
  record(row: OperatorActionRow): void {
    if (!this.surreal) return;
    void this.persist(row).catch((e) => {
      this.logger.warn(
        `operator_action persist failed (${row.method} ${row.path}): ${(e as Error).message}`,
      );
    });
  }

  async list(filter: {
    actor?: string | undefined;
    pathPrefix?: string | undefined;
    since?: string | undefined;
    limit?: number | undefined;
  }): Promise<OperatorActionRow[]> {
    if (!this.surreal || !this.apiKeys) return [];
    const tenants = filter.actor ? [filter.actor] : this.apiKeys.knownCompanyIds();
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.pathPrefix) {
      where.push('string::starts_with(path, $pathPrefix)');
      params.pathPrefix = filter.pathPrefix;
    }
    if (filter.since) {
      where.push('ts >= type::datetime($since)');
      params.since = filter.since;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const out: OperatorActionRow[] = [];
    for (const companyId of tenants) {
      try {
        const rows = await this.surreal.withCompany(companyId, async (db) =>
          queryRows<OperatorActionDbRow>(
            db,
            `SELECT ts, actor, scopes, method, path, status, durationMs,
                    query, bodySummary
               FROM operator_action ${whereSql}
              ORDER BY ts DESC LIMIT ${limit}`,
            params,
          ),
        );
        for (const r of rows) {
          out.push({
            ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
            actor: r.actor,
            scopes: Array.isArray(r.scopes) ? r.scopes : [],
            method: r.method,
            path: r.path,
            status: r.status,
            durationMs: r.durationMs ?? 0,
            query: r.query ?? null,
            bodySummary: r.bodySummary ?? null,
            companyId,
          });
        }
      } catch (e) {
        this.logger.warn(`operator_action read failed for ${companyId}: ${(e as Error).message}`);
      }
    }
    out.sort((a, b) => b.ts.localeCompare(a.ts));
    return out.slice(0, limit);
  }

  private async persist(row: OperatorActionRow): Promise<void> {
    if (!this.surreal) return;
    // `query`/`bodySummary` are option<object|string> — a JS null binds
    // as Surreal NULL, which 3.x refuses to coerce into an option field
    // (`Expected none | object but found NULL`; caught live by the V5
    // MS leg: every audited maintenance call 500'd). Absent means
    // absent: omit the fields instead of binding null.
    // `ts` is a datetime field — 3.x refuses a bound ISO string (WARN
    // per audited call, caught live by the W3 leg boot); bind a Date.
    const content: Record<string, unknown> = {
      ts: new Date(row.ts),
      actor: row.actor,
      scopes: row.scopes,
      method: row.method,
      path: row.path,
      status: row.status,
      durationMs: row.durationMs,
      ...(row.query != null ? { query: row.query } : {}),
      ...(row.bodySummary != null ? { bodySummary: row.bodySummary } : {}),
    };
    await this.surreal.withCompany(row.companyId, async (db) => {
      await db.query(`CREATE operator_action CONTENT $content`, { content });
    });
  }
}
