import { BadRequestException, Injectable } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { PolicyStoreService } from './policy-store.service';
import { keyIdOf } from './policy-keys.service';

/** SurrealDB returns datetimes as a Date on 3.x and an ISO string via JSON. */
type RawDateTime = string | number | Date;

/** Raw policy_decision row (SELECT *) before mapEvent shaping. Values that
 *  are stringified / numeric-coerced downstream are typed `unknown`. */
interface PolicyDecisionRow {
  id: unknown;
  ts: RawDateTime;
  keyHash?: unknown;
  kind: DecisionEvent['kind'];
  decision: DecisionEvent['decision'];
  mode: DecisionEvent['mode'];
  action?: unknown;
  policySet?: unknown;
  ruleId?: unknown;
  requestId?: unknown;
  rowCounts?: { total?: unknown; denied?: unknown } | null;
  samplePredicates?: unknown;
  sampled?: unknown;
}

/** Projected columns behind the report_only → enforce stats aggregation.
 *  action/policySet/ruleId/keyHash are string columns — typed concretely so
 *  the rule-key template literal and the map keys stay string-safe. */
interface PolicyDecisionStatRow {
  ts: RawDateTime;
  decision: DecisionEvent['decision'];
  action?: string;
  policySet?: string;
  ruleId?: string;
  keyHash?: string;
}

export interface DecisionEvent {
  id: string;
  ts: string;
  keyId: string;
  kind: 'action' | 'row';
  decision: 'allow' | 'deny' | 'would_deny';
  mode: 'report_only' | 'enforce';
  action?: string;
  policySet?: string;
  ruleId?: string;
  requestId?: string;
  rowCounts?: { total: number; denied: number };
  samplePredicates?: string[];
  sampled: boolean;
}

export interface DecisionsFeed {
  decisions: DecisionEvent[];
  nextCursor?: string;
}

export interface DecisionsStats {
  windowDays: number;
  series: Array<{ day: string; allow: number; deny: number; wouldDeny: number }>;
  topDeniedActions: Array<{ action: string; count: number }>;
  topRules: Array<{ policySet: string; ruleId: string; count: number }>;
  byKey: Array<{ keyId: string; deny: number; wouldDeny: number }>;
  reportOnlySets: Array<{
    name: string;
    sinceDays: number;
    wouldDeny: number;
  }>;
  /** True when the window hit the aggregation row cap (counts are lower bounds). */
  truncated: boolean;
}

const FEED_MAX_LIMIT = 200;
const STATS_ROW_CAP = 20_000;

/**
 * Read side of the policy_decision stream: the admin decisions feed
 * (cursor-paginated, filterable) and the aggregates behind the
 * report_only → enforce promotion panel. Aggregation happens in JS
 * over a capped window read — decision rows are already per-request
 * aggregates + sampled allows, so the volume is bounded; `truncated`
 * says when the cap was hit.
 */
@Injectable()
export class PolicyDecisionsService {
  constructor(
    private readonly surreal: SurrealService,
    private readonly store: PolicyStoreService,
  ) {}

  async feed(
    companyId: string,
    filters: {
      policySet?: string;
      decision?: string;
      kind?: string;
      action?: string;
      limit?: number;
      before?: string;
    },
  ): Promise<DecisionsFeed> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), FEED_MAX_LIMIT);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: limit + 1 };
    if (filters.policySet) {
      clauses.push('policySet = $policySet');
      params.policySet = filters.policySet;
    }
    if (filters.decision) {
      if (!['allow', 'deny', 'would_deny'].includes(filters.decision)) {
        throw new BadRequestException(`Unknown decision '${filters.decision}'`);
      }
      clauses.push('decision = $decision');
      params.decision = filters.decision;
    }
    if (filters.kind) {
      if (!['action', 'row'].includes(filters.kind)) {
        throw new BadRequestException(`Unknown kind '${filters.kind}'`);
      }
      clauses.push('kind = $kind');
      params.kind = filters.kind;
    }
    if (filters.action) {
      clauses.push('action = $action');
      params.action = filters.action;
    }
    if (filters.before) {
      const before = new Date(filters.before);
      if (Number.isNaN(before.getTime())) {
        throw new BadRequestException('before must be an ISO datetime');
      }
      clauses.push('ts < $before');
      params.before = before;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<PolicyDecisionRow>(
        db,
        `SELECT * FROM policy_decision ${where}
          ORDER BY ts DESC LIMIT $limit`,
        params,
      ),
    );
    const page = rows.slice(0, limit);
    const decisions = page.map(mapEvent);
    return {
      decisions,
      ...(rows.length > limit && decisions.length > 0
        ? { nextCursor: decisions[decisions.length - 1]!.ts }
        : {}),
    };
  }

  async stats(companyId: string, windowDays = 7): Promise<DecisionsStats> {
    const days = Math.min(Math.max(windowDays, 1), 30);
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<PolicyDecisionStatRow>(
        db,
        `SELECT ts, decision, action, policySet, ruleId, keyHash
           FROM policy_decision
          WHERE ts > time::now() - ${days}d
          ORDER BY ts DESC
          LIMIT ${STATS_ROW_CAP}`,
      ),
    );

    const series = new Map<string, { allow: number; deny: number; wouldDeny: number }>();
    const deniedActions = new Map<string, number>();
    const rules = new Map<string, number>();
    const byKey = new Map<string, { deny: number; wouldDeny: number }>();
    const wouldDenyBySet = new Map<string, number>();

    for (const row of rows) {
      const day = new Date(row.ts).toISOString().slice(0, 10);
      const bucket = series.get(day) ?? { allow: 0, deny: 0, wouldDeny: 0 };
      if (row.decision === 'allow') bucket.allow += 1;
      else if (row.decision === 'deny') bucket.deny += 1;
      else bucket.wouldDeny += 1;
      series.set(day, bucket);

      if (row.decision === 'deny' || row.decision === 'would_deny') {
        if (row.action) {
          deniedActions.set(
            String(row.action),
            (deniedActions.get(String(row.action)) ?? 0) + 1,
          );
        }
        if (row.policySet && row.ruleId) {
          const key = `${row.policySet}\u0000${row.ruleId}`;
          rules.set(key, (rules.get(key) ?? 0) + 1);
        }
        const keyId = keyIdOf(String(row.keyHash ?? ''));
        const k = byKey.get(keyId) ?? { deny: 0, wouldDeny: 0 };
        if (row.decision === 'deny') k.deny += 1;
        else k.wouldDeny += 1;
        byKey.set(keyId, k);
        if (row.decision === 'would_deny' && row.policySet) {
          wouldDenyBySet.set(
            String(row.policySet),
            (wouldDenyBySet.get(String(row.policySet)) ?? 0) + 1,
          );
        }
      }
    }

    const sets = await this.store.list(companyId);
    const now = Date.now();
    const reportOnlySets = sets
      .filter((s) => s.mode === 'report_only')
      .map((s) => ({
        name: s.name,
        // Proxy for "how long in report_only": last document update.
        sinceDays: Math.max(
          0,
          Math.floor((now - new Date(s.updatedAt).getTime()) / 86_400_000),
        ),
        wouldDeny: wouldDenyBySet.get(s.name) ?? 0,
      }));

    const top = <K>(m: Map<K, number>, n: number) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

    return {
      windowDays: days,
      series: [...series.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, v]) => ({ day, ...v })),
      topDeniedActions: top(deniedActions, 10).map(([action, count]) => ({
        action,
        count,
      })),
      topRules: top(rules, 10).map(([key, count]) => {
        const [policySet = '', ruleId = ''] = key.split('\u0000');
        return { policySet, ruleId, count };
      }),
      byKey: [...byKey.entries()]
        .sort((a, b) => b[1].deny + b[1].wouldDeny - (a[1].deny + a[1].wouldDeny))
        .slice(0, 10)
        .map(([keyId, v]) => ({ keyId, ...v })),
      reportOnlySets,
      truncated: rows.length >= STATS_ROW_CAP,
    };
  }
}

function mapEvent(row: PolicyDecisionRow): DecisionEvent {
  return {
    id: String(row.id),
    ts: new Date(row.ts).toISOString(),
    keyId: keyIdOf(String(row.keyHash ?? '')),
    kind: row.kind,
    decision: row.decision,
    mode: row.mode,
    ...(row.action ? { action: String(row.action) } : {}),
    ...(row.policySet ? { policySet: String(row.policySet) } : {}),
    ...(row.ruleId ? { ruleId: String(row.ruleId) } : {}),
    ...(row.requestId ? { requestId: String(row.requestId) } : {}),
    ...(row.rowCounts
      ? {
          rowCounts: {
            total: Number(row.rowCounts.total ?? 0),
            denied: Number(row.rowCounts.denied ?? 0),
          },
        }
      : {}),
    ...(Array.isArray(row.samplePredicates) && row.samplePredicates.length > 0
      ? { samplePredicates: row.samplePredicates.map(String) }
      : {}),
    sampled: Boolean(row.sampled),
  };
}
