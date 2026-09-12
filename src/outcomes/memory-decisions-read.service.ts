import { BadRequestException, Injectable } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import type {
  MemoryDecision,
  MemoryDecisionsResponse,
  MemoryDecisionsStatsResponse,
} from '../contracts/admin/memory-decisions.schema';

/**
 * Read side of the serving-path decision stream (migration 0119).
 *
 * 0119 shipped a writer, three indexes (`createdAt`, `requestId`,
 * `decisionId`) and a retention cron — and no reader. Outside
 * MemoryDecisionService, every query against the table was the GDPR
 * forget cascade or the nightly prune: it wrote rows that existed only
 * to be deleted. This is the consumer the schema was built for.
 *
 * Shape follows PolicyDecisionsService deliberately — feed + stats,
 * cursor on the ordering column, aggregates computed in-process over a
 * capped scan. Two surfaces answering "why did the engine decide that"
 * should not have two idioms.
 */

/** SurrealDB returns datetimes as a Date on 3.x and an ISO string via JSON. */
type RawDateTime = string | number | Date;

interface DecisionReadRow {
  decisionId: unknown;
  decisionKind: MemoryDecision['decisionKind'];
  policyVersion: unknown;
  chosenAction: unknown;
  createdAt: RawDateTime;
  requestId?: unknown;
  actionScore?: unknown;
  observedState?: Record<string, unknown> | null;
  alternatives?: Array<{ action?: unknown; score?: unknown }> | null;
  costs?: Record<string, unknown> | null;
}

const FEED_MAX_LIMIT = 200;
const FEED_DEFAULT_LIMIT = 50;

/**
 * Ceiling on the stats scan. A tenant serving steadily produces one row
 * per abstain/escalate/zoom decision, so a 30-day window is unbounded in
 * principle; the response reports `sampled` and `truncated` so a capped
 * scan is never silently read as the whole window.
 */
const STATS_ROW_CAP = 20_000;

const KINDS = ['l3_escalation', 'abstain', 'lane_route', 'zoom', 'verdict'] as const;

function isoOf(value: RawDateTime): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Numbers only, finite only — the row is content-free and stays that way. */
function numberRecord(raw: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function mapRow(row: DecisionReadRow): MemoryDecision {
  // observedState is FLEXIBLE in 0119, so the read side cannot assume the
  // writer's whitelist held for every row already stored: admit finite
  // numbers and strings, drop everything else rather than serve an object
  // the content-free contract never promised.
  const observed: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(row.observedState ?? {})) {
    const keep = typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    if (keep) observed[k] = v as number | string;
  }
  const alternatives = (row.alternatives ?? [])
    .filter((a) => typeof a.action === 'string' && typeof a.score === 'number')
    .map((a) => ({ action: String(a.action), score: Number(a.score) }));
  const costs = numberRecord(row.costs);

  return {
    decisionId: String(row.decisionId),
    decisionKind: row.decisionKind,
    policyVersion: String(row.policyVersion),
    chosenAction: String(row.chosenAction),
    createdAt: isoOf(row.createdAt),
    ...(typeof row.requestId === 'string' ? { requestId: row.requestId } : {}),
    ...(typeof row.actionScore === 'number' ? { actionScore: row.actionScore } : {}),
    ...(Object.keys(observed).length > 0 ? { observedState: observed } : {}),
    ...(alternatives.length > 0 ? { alternatives } : {}),
    ...(Object.keys(costs).length > 0 ? { costs } : {}),
  };
}

/** Running mean that never divides by zero and never carries a NaN out. */
function mean(total: number, n: number): number | undefined {
  return n > 0 ? Math.round((total / n) * 100) / 100 : undefined;
}

interface ActionTally {
  count: number;
  latency: { total: number; n: number };
  prompt: { total: number; n: number };
  completion: { total: number; n: number };
}

function addCost(tally: { total: number; n: number }, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    tally.total += value;
    tally.n += 1;
  }
}

@Injectable()
export class MemoryDecisionsReadService {
  constructor(private readonly surreal: SurrealService) {}

  async feed(
    companyId: string,
    filters: {
      decisionKind?: string;
      chosenAction?: string;
      policyVersion?: string;
      requestId?: string;
      limit?: number;
      before?: string;
    },
  ): Promise<MemoryDecisionsResponse> {
    const limit = Math.min(Math.max(filters.limit ?? FEED_DEFAULT_LIMIT, 1), FEED_MAX_LIMIT);
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: limit + 1 };

    if (filters.decisionKind !== undefined) {
      if (!KINDS.includes(filters.decisionKind as (typeof KINDS)[number])) {
        throw new BadRequestException(
          `Unknown decisionKind '${filters.decisionKind}' — expected one of ${KINDS.join(', ')}`,
        );
      }
      clauses.push('decisionKind = $decisionKind');
      params.decisionKind = filters.decisionKind;
    }
    if (filters.chosenAction !== undefined) {
      clauses.push('chosenAction = $chosenAction');
      params.chosenAction = filters.chosenAction;
    }
    if (filters.policyVersion !== undefined) {
      clauses.push('policyVersion = $policyVersion');
      params.policyVersion = filters.policyVersion;
    }
    if (filters.requestId !== undefined) {
      // The whole point of the requestId index: pull every decision one
      // request made, in order, as one trace.
      clauses.push('requestId = $requestId');
      params.requestId = filters.requestId;
    }
    if (filters.before !== undefined) {
      const before = new Date(filters.before);
      if (Number.isNaN(before.getTime())) {
        throw new BadRequestException('before must be an ISO datetime');
      }
      clauses.push('createdAt < $before');
      params.before = before;
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<DecisionReadRow>(
        db,
        `SELECT decisionId, decisionKind, policyVersion, chosenAction, createdAt,
                requestId, actionScore, observedState, alternatives, costs
           FROM memory_decision ${where}
          ORDER BY createdAt DESC LIMIT $limit`,
        params,
      ),
    );

    const page = rows.slice(0, limit);
    const decisions = page.map(mapRow);
    return {
      decisions,
      ...(rows.length > limit && decisions.length > 0
        ? { nextCursor: decisions[decisions.length - 1]!.createdAt }
        : {}),
    };
  }

  async stats(companyId: string, windowDays = 7): Promise<MemoryDecisionsStatsResponse> {
    const days = Math.min(Math.max(windowDays, 1), 30);
    const rows = await this.surreal.withCompany(companyId, (db) =>
      queryRows<DecisionReadRow>(
        db,
        `SELECT decisionKind, policyVersion, chosenAction, createdAt, costs
           FROM memory_decision
          WHERE createdAt > time::now() - ${days}d
          ORDER BY createdAt DESC
          LIMIT ${STATS_ROW_CAP}`,
      ),
    );

    const byAction = new Map<
      string,
      ActionTally & { kind: MemoryDecision['decisionKind']; action: string }
    >();
    const byVersion = new Map<string, { count: number; kinds: Set<string> }>();
    const series = new Map<string, Record<string, number>>();

    for (const row of rows) {
      const kind = row.decisionKind;
      const action = String(row.chosenAction);
      // JSON, not a delimiter character: chosenAction is a caller-shaped
      // string ('skip:<reason>'), so any literal separator is a guess about
      // what cannot appear inside it.
      const key = JSON.stringify([kind, action]);
      const tally = byAction.get(key) ?? {
        kind,
        action,
        count: 0,
        latency: { total: 0, n: 0 },
        prompt: { total: 0, n: 0 },
        completion: { total: 0, n: 0 },
      };
      tally.count += 1;
      addCost(tally.latency, row.costs?.latencyMs);
      addCost(tally.prompt, row.costs?.promptTokens);
      addCost(tally.completion, row.costs?.completionTokens);
      byAction.set(key, tally);

      const version = String(row.policyVersion);
      const v = byVersion.get(version) ?? { count: 0, kinds: new Set<string>() };
      v.count += 1;
      v.kinds.add(kind);
      byVersion.set(version, v);

      const day = isoOf(row.createdAt).slice(0, 10);
      const bucket = series.get(day) ?? {};
      bucket[kind] = (bucket[kind] ?? 0) + 1;
      series.set(day, bucket);
    }

    return {
      windowDays: days,
      sampled: rows.length,
      truncated: rows.length >= STATS_ROW_CAP,
      byAction: [...byAction.values()]
        .sort((a, b) => b.count - a.count)
        .map((t) => ({
          decisionKind: t.kind,
          chosenAction: t.action,
          count: t.count,
          ...(mean(t.latency.total, t.latency.n) !== undefined
            ? { avgLatencyMs: mean(t.latency.total, t.latency.n)! }
            : {}),
          ...(mean(t.prompt.total, t.prompt.n) !== undefined
            ? { avgPromptTokens: mean(t.prompt.total, t.prompt.n)! }
            : {}),
          ...(mean(t.completion.total, t.completion.n) !== undefined
            ? { avgCompletionTokens: mean(t.completion.total, t.completion.n)! }
            : {}),
        })),
      byPolicyVersion: [...byVersion.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([policyVersion, v]) => ({
          policyVersion,
          count: v.count,
          kinds: [...v.kinds] as MemoryDecision['decisionKind'][],
        })),
      series: [...series.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([day, counts]) => ({ day, counts })),
    };
  }
}
