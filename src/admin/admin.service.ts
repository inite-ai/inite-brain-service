import { Injectable, Logger } from '@nestjs/common';
import { ApiKeyService } from '../auth/api-key.service';
import { SurrealService, queryRows } from '../db/surreal.service';
import { MetricsService } from '../metrics/metrics.service';
import { mapWithLimit } from '../common/parallel';
import { envFlagEnabled } from '../common/env-validation';

/** Per-tenant fan-out concurrency for admin cross-tenant reads. */
const TENANT_FANOUT = 4;

export interface AdminTenantRow {
  companyId: string;
  entities: number;
  factsActive: number;
  factsRetracted: number;
}

export interface AdminDeadLetterRow {
  companyId: string;
  id: string;
  reason: string;
  rejectedAt: string;
  payload: Record<string, unknown>;
}

export interface AdminForgottenRow {
  companyId: string;
  entityIdHash: string;
  reason: string;
  forgottenAt: string;
  factsDeleted: number;
  edgesDeleted: number;
}

export interface AdminMetrics {
  /** Sum of `brain_ingest_facts_total` across all label sets. */
  ingestFactsTotal: number;
  ingestFactsByOutcome: Record<string, number>;
  /** Sum of `brain_search_duration_seconds_count` (= search calls). */
  searchCallsTotal: number;
  dreamsRunsTotal: number;
  dreamsEmittedByKind: Record<string, number>;
  retractsTotal: number;
  forgetsTotal: number;
  openaiCallsTotal: number;
  openaiTokensTotal: number;
}

export interface AdminOverview {
  generatedAt: string;
  health: { surrealdb: 'ok' | 'unreachable' };
  totals: {
    tenants: number;
    entities: number;
    factsActive: number;
    factsRetracted: number;
    deadLetterLast24h: number;
    forgottenLast24h: number;
  };
  metrics: AdminMetrics;
  tenants: AdminTenantRow[];
  recentDeadLetter: AdminDeadLetterRow[];
  recentForgotten: AdminForgottenRow[];
}

export interface AuditEventRow {
  id: string;
  companyId: string;
  source: string;
  recordId: string;
  op: 'create' | 'update' | 'delete' | 'define' | string;
  ts: string;
  versionstamp: number;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  consumedBy: string;
}

export interface AuditQuery {
  companyId?: string | undefined;
  source?: string | undefined;
  op?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}

export interface CostBucket {
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
}

export interface CostBreakdown {
  total: { usd: number; tokens: number; calls: number };
  perModel: CostBucket[];
  perOperation: CostBucket[];
  perTenant: CostBucket[];
  pricing: Record<string, { promptPerMTok: number; completionPerMTok: number }>;
  source: 'metrics';
}

export interface AuditPage {
  events: AuditEventRow[];
  totalsBySource: Record<string, number>;
  totalsByOp: Record<string, number>;
  hourly: Array<{ hour: string; count: number }>;
}

// ── Local DB row shapes ────────────────────────────────────────────────
// Column projections of the SurrealDB reads below. Fields carry the type
// the mapping code depends on; genuinely-dynamic columns funnelled through
// String()/Number()/new Date() are typed `unknown`.

/** `count() AS c ... GROUP ALL` result row. */
interface CountRow {
  c?: number;
}

/** `SELECT n FROM stats_entity_total` computed-view row. */
interface ViewCountRow {
  n?: number;
}

/** `SELECT n, status FROM stats_fact_by_status` computed-view row. */
interface StatusCountRow {
  n?: number;
  status?: string;
}

/** Columns read from `ingest_dead_letter`. */
interface DeadLetterRow {
  id?: unknown;
  reason: string;
  rejectedAt: string | Date;
  payload?: Record<string, unknown>;
}

/** Columns read from `forgotten_entity`. */
interface ForgottenRow {
  entityIdHash: string;
  reason: string;
  forgottenAt: string | Date;
  factsDeleted?: number;
  edgesDeleted?: number;
}

/** Columns read from `audit_event`. */
interface AuditEventDbRow {
  id?: unknown;
  source?: unknown;
  recordId?: unknown;
  op?: unknown;
  ts: string | Date;
  versionstamp?: unknown;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  consumedBy?: unknown;
}

/** PII-classed predicate rows from `knowledge_predicate`. */
interface PiiPredicateRow {
  predicateId: string;
  piiClass: string;
  requiresScope?: string;
}

/** Per-(predicate,status) fact counts for the PII inventory. */
interface PiiCountRow {
  predicate?: string;
  status?: string;
  c?: unknown;
}

/**
 * Cross-tenant read-only fan-out for the admin dashboard.
 *
 * Each per-tenant query goes through `withCompany` (ROOT pool, no PII
 * fence) because the admin operator already holds `brain:admin` and
 * we want raw counts, not scoped views. Tenants iterate sequentially
 * to bound pool pressure — operator-facing call, latency is not
 * user-critical.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  /** Tenants whose view-read failure has already been logged (log once). */
  private readonly viewFallbackLogged = new Set<string>();

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly surreal: SurrealService,
    private readonly metrics: MetricsService,
  ) {}

  async buildOverview(): Promise<AdminOverview> {
    const dbOk = await this.surreal.ping().catch(() => false);
    const tenants = this.apiKeys.knownCompanyIds();
    const metricsSnapshot = await this.snapshotMetrics();

    const rows: AdminTenantRow[] = [];
    const recentDeadLetter: AdminDeadLetterRow[] = [];
    const recentForgotten: AdminForgottenRow[] = [];

    let deadLetter24h = 0;
    let forgotten24h = 0;
    const dayAgoIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    // Parallel fan-out — sequential was N × per-tenant-Surreal-RTT which
    // turned the overview into a 5s+ page under 20 tenants. Cap at
    // TENANT_FANOUT so we don't drain the Surreal pool either.
    const tenantResults = await mapWithLimit({
      items: tenants,
      concurrency: TENANT_FANOUT,
      fn: (companyId) => this.collectTenant(companyId, dayAgoIso),
      onError: (err, companyId) =>
        this.logger.warn(`Failed to collect admin overview for ${companyId}: ${err.message}`),
    });
    tenants.forEach((companyId, i) => {
      const data = tenantResults[i];
      if (!data) {
        rows.push({
          companyId,
          entities: -1,
          factsActive: -1,
          factsRetracted: -1,
        });
        return;
      }
      rows.push(data.row);
      recentDeadLetter.push(...data.deadLetter);
      recentForgotten.push(...data.forgotten);
      deadLetter24h += data.deadLetter24h;
      forgotten24h += data.forgotten24h;
    });

    // Sort recent lists across tenants, keep last 20.
    recentDeadLetter.sort((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
    recentForgotten.sort((a, b) => b.forgottenAt.localeCompare(a.forgottenAt));

    return {
      generatedAt: new Date().toISOString(),
      health: { surrealdb: dbOk ? 'ok' : 'unreachable' },
      totals: {
        tenants: tenants.length,
        entities: sum(rows.map((r) => r.entities)),
        factsActive: sum(rows.map((r) => r.factsActive)),
        factsRetracted: sum(rows.map((r) => r.factsRetracted)),
        deadLetterLast24h: deadLetter24h,
        forgottenLast24h: forgotten24h,
      },
      metrics: metricsSnapshot,
      tenants: rows,
      recentDeadLetter: recentDeadLetter.slice(0, 20),
      recentForgotten: recentForgotten.slice(0, 20),
    };
  }

  /**
   * Pulls a curated subset of prom-client counters out of the in-process
   * registry. Avoids exposing the full /metrics scrape through the admin
   * BFF — operators see the high-signal stuff, the rest stays in
   * Prometheus.
   */
  private async snapshotMetrics(): Promise<AdminMetrics> {
    type Bucket = {
      name: string;
      labels?: Partial<Record<string, string | number>>;
      value: number;
    };
    const byName: Record<string, Bucket[]> = {};
    try {
      const all = await this.metrics.registry.getMetricsAsJSON();
      for (const m of all) {
        if (!m.name.startsWith('brain_')) continue;
        const values = m.values ?? [];
        byName[m.name] = values.map((v) => ({
          name: m.name,
          labels: v.labels ?? {},
          value: typeof v.value === 'number' ? v.value : 0,
        }));
      }
    } catch (e) {
      this.logger.warn(`metrics snapshot failed: ${(e as Error).message}`);
    }

    const sumBuckets = (name: string): number =>
      (byName[name] ?? []).reduce((acc, b) => acc + b.value, 0);

    const groupByLabel = (name: string, labelKey: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const b of byName[name] ?? []) {
        const k = b.labels?.[labelKey] ?? '_unknown';
        out[k] = (out[k] ?? 0) + b.value;
      }
      return out;
    };

    return {
      ingestFactsTotal: sumBuckets('brain_ingest_facts_total'),
      ingestFactsByOutcome: groupByLabel('brain_ingest_facts_total', 'outcome'),
      // prom-client emits *_count companion for every Histogram.
      searchCallsTotal: sumBuckets('brain_search_duration_seconds_count'),
      dreamsRunsTotal: sumBuckets('brain_dreams_total'),
      dreamsEmittedByKind: groupByLabel('brain_dreams_emitted_total', 'kind'),
      retractsTotal: sumBuckets('brain_retract_total'),
      forgetsTotal: sumBuckets('brain_forget_total'),
      openaiCallsTotal: sumBuckets('brain_openai_calls_total'),
      openaiTokensTotal: sumBuckets('brain_openai_tokens_total'),
    };
  }

  /**
   * Process-wide cost rollup from the Prometheus registry.
   *
   * The OpenAI counter is labelled (kind, type) where:
   *   - kind ∈ {chat, embed}
   *   - type ∈ {prompt, completion}
   * which is the only attribution the in-process counter carries.
   * Per-tenant attribution is not yet emitted in metric labels (would
   * require lifting companyId into every Counter.inc call), so the
   * perTenant bucket is empty until that lands; we expose the same
   * shape so the UI doesn't need a special case once it does.
   *
   * Pricing defaults reflect the v2.2.8 default models (gpt-4o-mini +
   * text-embedding-3-small). Overridable via env so the operator can
   * pin their negotiated rates without redeploying.
   */
  async buildCostBreakdown(): Promise<CostBreakdown> {
    const pricing = this.resolvePricing();
    type Sample = { value: number; labels: Record<string, string> };
    const tokens = (await this.collectMetric('brain_openai_tokens_total')) as Sample[];
    const calls = (await this.collectMetric('brain_openai_calls_total')) as Sample[];
    const perModelMap = new Map<string, CostBucket>();
    const perOpMap = new Map<string, CostBucket>();
    let totalTokens = 0;
    let totalUsd = 0;
    for (const t of tokens) {
      const kind = t.labels.kind ?? 'unknown';
      const type = t.labels.type ?? 'unknown';
      const modelKey = kind === 'chat' ? 'chat' : kind === 'embed' ? 'embed' : kind;
      const price = pricing[modelKey] ?? {
        promptPerMTok: 0,
        completionPerMTok: 0,
      };
      const usd =
        type === 'prompt'
          ? (t.value * price.promptPerMTok) / 1_000_000
          : type === 'completion'
            ? (t.value * price.completionPerMTok) / 1_000_000
            : 0;
      const modelBucket =
        perModelMap.get(modelKey) ??
        ({
          key: modelKey,
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          usd: 0,
        } as CostBucket);
      const opBucket =
        perOpMap.get(kind) ??
        ({
          key: kind,
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          usd: 0,
        } as CostBucket);
      if (type === 'prompt') {
        modelBucket.promptTokens += t.value;
        opBucket.promptTokens += t.value;
      } else if (type === 'completion') {
        modelBucket.completionTokens += t.value;
        opBucket.completionTokens += t.value;
      }
      modelBucket.totalTokens += t.value;
      opBucket.totalTokens += t.value;
      modelBucket.usd += usd;
      opBucket.usd += usd;
      perModelMap.set(modelKey, modelBucket);
      perOpMap.set(kind, opBucket);
      totalTokens += t.value;
      totalUsd += usd;
    }
    let totalCalls = 0;
    for (const c of calls) {
      const kind = c.labels.kind ?? 'unknown';
      totalCalls += c.value;
      const bucket = perOpMap.get(kind);
      if (bucket) bucket.calls += c.value;
      const modelKey = kind === 'chat' ? 'chat' : kind === 'embed' ? 'embed' : kind;
      const mb = perModelMap.get(modelKey);
      if (mb) mb.calls += c.value;
    }
    return {
      total: { usd: totalUsd, tokens: totalTokens, calls: totalCalls },
      perModel: [...perModelMap.values()].sort((a, b) => b.usd - a.usd),
      perOperation: [...perOpMap.values()].sort((a, b) => b.usd - a.usd),
      perTenant: [],
      pricing,
      source: 'metrics',
    };
  }

  private resolvePricing(): CostBreakdown['pricing'] {
    const parse = (val: string | undefined, fallback: number) => {
      const n = val ? parseFloat(val) : NaN;
      return Number.isFinite(n) ? n : fallback;
    };
    const env = process.env;
    return {
      chat: {
        promptPerMTok: parse(env.COST_CHAT_PROMPT_USD_PER_MTOK, 0.15),
        completionPerMTok: parse(env.COST_CHAT_COMPLETION_USD_PER_MTOK, 0.6),
      },
      embed: {
        promptPerMTok: parse(env.COST_EMBED_USD_PER_MTOK, 0.02),
        completionPerMTok: 0,
      },
    };
  }

  private async collectMetric(
    name: string,
  ): Promise<Array<{ value: number; labels: Record<string, string> }>> {
    try {
      const all = await this.metrics.registry.getMetricsAsJSON();
      const m = all.find((x) => x.name === name);
      const values = m?.values ?? [];
      return values.map((v) => ({
        value: typeof v.value === 'number' ? v.value : 0,
        labels: (v.labels as Record<string, string>) ?? {},
      }));
    } catch (e) {
      this.logger.warn(`collectMetric ${name} failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Full DLQ listing with filter + pagination. Used by /admin/dlq
   * page; the overview already shows last 20.
   */
  async listDeadLetter(filter: {
    companyId?: string | undefined;
    reason?: string | undefined;
    limit?: number | undefined;
  }): Promise<AdminDeadLetterRow[]> {
    const tenants = filter.companyId ? [filter.companyId] : this.apiKeys.knownCompanyIds();
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const out: AdminDeadLetterRow[] = [];
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.reason) {
      where.push('reason = $reason');
      params.reason = filter.reason;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const perTenant = await mapWithLimit({
      items: tenants,
      concurrency: TENANT_FANOUT,
      fn: async (companyId) => {
        const rows = await this.surreal.withCompany(companyId, async (db) =>
          queryRows<DeadLetterRow>(
            db,
            `SELECT id, reason, rejectedAt, payload
               FROM ingest_dead_letter ${whereSql}
              ORDER BY rejectedAt DESC LIMIT ${limit}`,
            params,
          ),
        );
        return rows.map((r) => ({
          companyId,
          id: String(r.id),
          reason: r.reason,
          rejectedAt: new Date(r.rejectedAt).toISOString(),
          payload: r.payload ?? {},
        }));
      },
      onError: (err, companyId) =>
        this.logger.warn(`dead-letter list failed for ${companyId}: ${err.message}`),
    });
    for (const batch of perTenant) {
      if (batch) out.push(...batch);
    }
    out.sort((a, b) => b.rejectedAt.localeCompare(a.rejectedAt));
    return out.slice(0, limit);
  }

  /**
   * Permanently delete a dead-letter row. Reversible only via DB
   * backup. Caller should already have confirmed at the UI layer.
   */
  async deleteDeadLetter(companyId: string, id: string): Promise<boolean> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const rows = await queryRows<unknown>(
          db,
          `DELETE ingest_dead_letter WHERE id = $id RETURN BEFORE`,
          { id },
        );
        return rows.length > 0;
      });
    } catch (e) {
      this.logger.warn(`dead-letter delete failed (${companyId}/${id}): ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Full forgotten-entities list with filter. Used by /admin/forgotten
   * page; also drives the GDPR export endpoint.
   */
  async listForgotten(filter: {
    companyId?: string | undefined;
    reason?: string | undefined;
    since?: string | undefined;
    limit?: number | undefined;
  }): Promise<AdminForgottenRow[]> {
    const tenants = filter.companyId ? [filter.companyId] : this.apiKeys.knownCompanyIds();
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.reason) {
      where.push('reason = $reason');
      params.reason = filter.reason;
    }
    if (filter.since) {
      where.push('forgottenAt >= type::datetime($since)');
      params.since = filter.since;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const out: AdminForgottenRow[] = [];
    const perTenant = await mapWithLimit({
      items: tenants,
      concurrency: TENANT_FANOUT,
      fn: async (companyId) => {
        const rows = await this.surreal.withCompany(companyId, async (db) =>
          queryRows<ForgottenRow>(
            db,
            `SELECT entityIdHash, reason, forgottenAt, factsDeleted, edgesDeleted
               FROM forgotten_entity ${whereSql}
              ORDER BY forgottenAt DESC LIMIT ${limit}`,
            params,
          ),
        );
        return rows.map((r) => ({
          companyId,
          entityIdHash: r.entityIdHash,
          reason: r.reason,
          forgottenAt: new Date(r.forgottenAt).toISOString(),
          factsDeleted: r.factsDeleted ?? 0,
          edgesDeleted: r.edgesDeleted ?? 0,
        }));
      },
      onError: (err, companyId) =>
        this.logger.warn(`forgotten list failed for ${companyId}: ${err.message}`),
    });
    for (const batch of perTenant) {
      if (batch) out.push(...batch);
    }
    out.sort((a, b) => b.forgottenAt.localeCompare(a.forgottenAt));
    return out.slice(0, limit);
  }

  /**
   * Cross-tenant PII inventory: for each tenant, count facts grouped
   * by piiClass (derived from the predicate's requiresScope) so an
   * operator sees "how many sensitive rows do we hold for tenant X?"
   * Drives the /admin/pii page.
   */
  async listPiiInventory(): Promise<
    Array<{
      companyId: string;
      predicate: string;
      piiClass: string;
      requiresScope: string;
      factCount: number;
      retractedCount: number;
    }>
  > {
    const tenants = this.apiKeys.knownCompanyIds();
    const out: Array<{
      companyId: string;
      predicate: string;
      piiClass: string;
      requiresScope: string;
      factCount: number;
      retractedCount: number;
    }> = [];
    for (const companyId of tenants) {
      try {
        // One connection + two queries per tenant. The old shape opened
        // a fresh withCompany and ran two GROUP ALL counts PER PII
        // predicate — 50 tenants × 10 predicates ≈ 1000+ serial round
        // trips inside one admin HTTP request.
        const { rows, counts } = await this.surreal.withCompany(companyId, async (db) => {
          const predRows = await queryRows<PiiPredicateRow>(
            db,
            `SELECT predicateId, piiClass, requiresScope FROM knowledge_predicate
                WHERE piiClass != 'none'`,
          );
          const preds = predRows.map((p) => p.predicateId);
          if (preds.length === 0) {
            return {
              rows: [] as PiiPredicateRow[],
              counts: new Map<string, number>(),
            };
          }
          const countRows = await queryRows<PiiCountRow>(
            db,
            `SELECT predicate, status, count() AS c FROM knowledge_fact
                WHERE predicate INSIDE $preds
                  AND status INSIDE ['active', 'retracted']
                GROUP BY predicate, status`,
            { preds },
          );
          const counts = new Map<string, number>();
          for (const r of countRows) {
            counts.set(`${r.predicate}|${r.status}`, Number(r.c) || 0);
          }
          return { rows: predRows, counts };
        });
        for (const p of rows) {
          out.push({
            companyId,
            predicate: p.predicateId,
            piiClass: p.piiClass,
            requiresScope: p.requiresScope ?? '',
            factCount: counts.get(`${p.predicateId}|active`) ?? 0,
            retractedCount: counts.get(`${p.predicateId}|retracted`) ?? 0,
          });
        }
      } catch (e) {
        this.logger.warn(`pii inventory failed for ${companyId}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Cross-tenant read of `audit_event` (migration 0023). Per-tenant
   * iteration mirrors `buildOverview` — the consumer writes events
   * inside each tenant DB, so this fans out the same way.
   *
   * Filters: optional companyId pin, source ('knowledge_fact' etc.),
   * op ('create' | 'update' | 'delete' | 'define'), [since,before)
   * window, hard limit (capped at 500). Always returns events sorted
   * desc by ts. Also returns aggregate totals for chart drawing.
   */
  async listAuditEvents(q: AuditQuery): Promise<AuditPage> {
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const tenants = q.companyId ? [q.companyId] : this.apiKeys.knownCompanyIds();
    const events: AuditEventRow[] = [];
    const totalsBySource: Record<string, number> = {};
    const totalsByOp: Record<string, number> = {};
    const hourlyBuckets = new Map<string, number>();

    const whereClauses: string[] = [];
    const bindings: Record<string, unknown> = {};
    if (q.source) {
      whereClauses.push('source = $source');
      bindings.source = q.source;
    }
    if (q.op) {
      whereClauses.push('op = $op');
      bindings.op = q.op;
    }
    if (q.since) {
      whereClauses.push('ts >= type::datetime($since)');
      bindings.since = q.since;
    }
    if (q.before) {
      whereClauses.push('ts < type::datetime($before)');
      bindings.before = q.before;
    }
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const perTenant = await mapWithLimit({
      items: tenants,
      concurrency: TENANT_FANOUT,
      fn: async (companyId) => {
        const rows = await this.surreal.withCompany(companyId, async (db) => {
          const sql = `
            SELECT id, source, recordId, op, ts, versionstamp, before, after, consumedBy
              FROM audit_event ${whereSql}
              ORDER BY ts DESC LIMIT ${limit};
          `;
          return queryRows<AuditEventDbRow>(db, sql, bindings);
        });
        return rows.map((r) => ({
          row: {
            id: String(r.id),
            companyId,
            source: r.source as string,
            recordId: r.recordId as string,
            op: r.op as string,
            ts: new Date(r.ts).toISOString(),
            versionstamp: Number(r.versionstamp ?? 0),
            before: (r.before ?? null) as Record<string, unknown> | null,
            after: (r.after ?? null) as Record<string, unknown> | null,
            consumedBy: (r.consumedBy ?? 'changefeed-consumer') as string,
          },
        }));
      },
      onError: (err, companyId) =>
        this.logger.warn(`listAuditEvents failed for ${companyId}: ${err.message}`),
    });
    for (const batch of perTenant) {
      if (!batch) continue;
      for (const { row } of batch) {
        events.push(row);
        totalsBySource[row.source] = (totalsBySource[row.source] ?? 0) + 1;
        totalsByOp[row.op] = (totalsByOp[row.op] ?? 0) + 1;
        const hour = row.ts.slice(0, 13);
        hourlyBuckets.set(hour, (hourlyBuckets.get(hour) ?? 0) + 1);
      }
    }

    events.sort((a, b) => b.ts.localeCompare(a.ts));
    return {
      events: events.slice(0, limit),
      totalsBySource,
      totalsByOp,
      hourly: [...hourlyBuckets.entries()]
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    };
  }

  private async collectTenant(
    companyId: string,
    dayAgoIso: string,
  ): Promise<{
    row: AdminTenantRow;
    deadLetter: AdminDeadLetterRow[];
    forgotten: AdminForgottenRow[];
    deadLetter24h: number;
    forgotten24h: number;
  }> {
    // STATS_VIEWS_ENABLED: read the entity/fact counters from the 0088
    // computed tables (incrementally maintained by SurrealDB on source
    // writes) instead of re-aggregating live. The 24h moving windows and
    // the last-20 row reads stay live in both paths. A failing view read
    // (pre-0088 tenant) logs once per tenant and falls back live.
    if (envFlagEnabled(process.env.STATS_VIEWS_ENABLED)) {
      try {
        return await this.collectTenantFromViews(companyId, dayAgoIso);
      } catch (err) {
        if (!this.viewFallbackLogged.has(companyId)) {
          this.viewFallbackLogged.add(companyId);
          this.logger.warn(
            `stats views unavailable for ${companyId} (pre-0088 tenant?), ` +
              `falling back to live counts: ${(err as Error).message}`,
          );
        }
      }
    }
    return this.surreal.withCompany(companyId, async (db) => {
      // Batched: counts + last-20 + 24h-window all in one round-trip
      // per tenant. SurrealDB returns one result array per statement
      // in execution order.
      const sql = `
        SELECT count() AS c FROM knowledge_entity GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'active' GROUP ALL;
        SELECT count() AS c FROM knowledge_fact WHERE status = 'retracted' GROUP ALL;
        SELECT id, reason, rejectedAt, payload FROM ingest_dead_letter
          ORDER BY rejectedAt DESC LIMIT 20;
        SELECT count() AS c FROM ingest_dead_letter
          WHERE rejectedAt > type::datetime($dayAgoIso) GROUP ALL;
        SELECT entityIdHash, reason, forgottenAt, factsDeleted, edgesDeleted
          FROM forgotten_entity ORDER BY forgottenAt DESC LIMIT 20;
        SELECT count() AS c FROM forgotten_entity
          WHERE forgottenAt > type::datetime($dayAgoIso) GROUP ALL;
      `;
      const res = await db.query<
        [
          CountRow[],
          CountRow[],
          CountRow[],
          DeadLetterRow[],
          CountRow[],
          ForgottenRow[],
          CountRow[],
        ]
      >(sql, { dayAgoIso });

      const c0 = countOf(res[0]);
      const c1 = countOf(res[1]);
      const c2 = countOf(res[2]);
      const deadLetterRows = res[3] ?? [];
      const dl24 = countOf(res[4]);
      const forgottenRows = res[5] ?? [];
      const fg24 = countOf(res[6]);

      return {
        row: {
          companyId,
          entities: c0,
          factsActive: c1,
          factsRetracted: c2,
        },
        deadLetter: deadLetterRows.map((r) => ({
          companyId,
          id: String(r.id),
          reason: r.reason,
          rejectedAt: new Date(r.rejectedAt).toISOString(),
          payload: r.payload ?? {},
        })),
        forgotten: forgottenRows.map((r) => ({
          companyId,
          entityIdHash: r.entityIdHash,
          reason: r.reason,
          forgottenAt: new Date(r.forgottenAt).toISOString(),
          factsDeleted: r.factsDeleted ?? 0,
          edgesDeleted: r.edgesDeleted ?? 0,
        })),
        deadLetter24h: dl24,
        forgotten24h: fg24,
      };
    });
  }

  /**
   * View-backed variant of collectTenant: the three plain counters come
   * from the 0088 rollup tables (one row fetch each); everything
   * time-windowed or row-shaped stays identical to the live path.
   */
  private async collectTenantFromViews(
    companyId: string,
    dayAgoIso: string,
  ): Promise<{
    row: AdminTenantRow;
    deadLetter: AdminDeadLetterRow[];
    forgotten: AdminForgottenRow[];
    deadLetter24h: number;
    forgotten24h: number;
  }> {
    return this.surreal.withCompany(companyId, async (db) => {
      const sql = `
        SELECT n FROM stats_entity_total;
        SELECT n, status FROM stats_fact_by_status;
        SELECT id, reason, rejectedAt, payload FROM ingest_dead_letter
          ORDER BY rejectedAt DESC LIMIT 20;
        SELECT count() AS c FROM ingest_dead_letter
          WHERE rejectedAt > type::datetime($dayAgoIso) GROUP ALL;
        SELECT entityIdHash, reason, forgottenAt, factsDeleted, edgesDeleted
          FROM forgotten_entity ORDER BY forgottenAt DESC LIMIT 20;
        SELECT count() AS c FROM forgotten_entity
          WHERE forgottenAt > type::datetime($dayAgoIso) GROUP ALL;
      `;
      const res = await db.query<
        [ViewCountRow[], StatusCountRow[], DeadLetterRow[], CountRow[], ForgottenRow[], CountRow[]]
      >(sql, { dayAgoIso });

      const entities = viewCountOf(res[0]);
      const byStatus = statusCountsOf(res[1]);
      const deadLetterRows = res[2] ?? [];
      const dl24 = countOf(res[3]);
      const forgottenRows = res[4] ?? [];
      const fg24 = countOf(res[5]);

      return {
        row: {
          companyId,
          entities,
          factsActive: byStatus.get('active') ?? 0,
          factsRetracted: byStatus.get('retracted') ?? 0,
        },
        deadLetter: deadLetterRows.map((r) => ({
          companyId,
          id: String(r.id),
          reason: r.reason,
          rejectedAt: new Date(r.rejectedAt).toISOString(),
          payload: r.payload ?? {},
        })),
        forgotten: forgottenRows.map((r) => ({
          companyId,
          entityIdHash: r.entityIdHash,
          reason: r.reason,
          forgottenAt: new Date(r.forgottenAt).toISOString(),
          factsDeleted: r.factsDeleted ?? 0,
          edgesDeleted: r.edgesDeleted ?? 0,
        })),
        deadLetter24h: dl24,
        forgotten24h: fg24,
      };
    });
  }

  /**
   * Drop a tenant's entire per-tenant database. The caller is responsible
   * for authorising this (the admin API restricts it to ephemeral eval_*
   * tenants) — this just performs the DB-level teardown.
   */
  async dropTenantDatabase(companyId: string): Promise<void> {
    await this.surreal.dropCompanyDatabase(companyId);
  }
}

function countOf(stmtResult: CountRow[]): number {
  if (!Array.isArray(stmtResult) || stmtResult.length === 0) return 0;
  const first = stmtResult[0];
  return typeof first?.c === 'number' ? first.c : 0;
}

/** Single-row GROUP ALL view: absent row (empty source) reads as 0. */
function viewCountOf(stmtResult: ViewCountRow[]): number {
  if (!Array.isArray(stmtResult) || stmtResult.length === 0) return 0;
  const first = stmtResult[0];
  return typeof first?.n === 'number' ? first.n : 0;
}

/** GROUP BY status view rows → status → n. Missing groups read as 0. */
function statusCountsOf(stmtResult: StatusCountRow[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(stmtResult)) return out;
  for (const row of stmtResult) {
    if (typeof row?.status === 'string' && typeof row?.n === 'number') {
      out.set(row.status, row.n);
    }
  }
  return out;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + (b > 0 ? b : 0), 0);
}
