import { policyFor } from '../ingest/conflict-resolver';
import { getPolicyContext, getPolicyRowRecorder } from '../common/request-context';
import { evaluateRow, toRowView } from './policy-engine';
import { PolicyContext } from './policy.types';

/**
 * Row-level enforcement seam shared by every read surface (search
 * fusion/backfill/edge-expansion, graph_retrieve, competing facts,
 * entity profile/timeline, code-memory recall).
 *
 * Two gates, in order:
 *   1. The predicate scope gate (requiresScope, e.g. brain:read_pii) —
 *      pre-ABAC behavior, always on, never weakened by a policy.
 *   2. The ABAC row verdict — only when the request carries a
 *      PolicyContext (from ApiKeyGuard via AsyncLocalStorage; an
 *      explicit `policy` option overrides for simulation).
 *
 * Decision telemetry is aggregated per filter instance (= per pipeline
 * invocation) and handed to the request's recorder on finish() — the
 * pure module stays DI-free, PolicyGateService owns sink + metrics.
 */

/** Minimal fact shape the filter needs — FactRow and friends satisfy it. */
export interface PolicyFilterableRow {
  id?: unknown;
  predicate: string;
  source?: unknown;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

export interface RowDecisionSummary {
  /** Which read surface produced this batch (search, graph_retrieve, …). */
  surface: string;
  /** Rows that reached the policy gate (after the scope gate). */
  total: number;
  evalSeconds: number;
  perSet: Array<{
    policySet: string;
    mode: 'report_only' | 'enforce';
    denied: number;
    wouldDeny: number;
    ruleIds: string[];
    sampleFactIds: string[];
    samplePredicates: string[];
  }>;
}

const SAMPLE_CAP = 3;

export interface RowPolicyFilter {
  /** True = row stays. False only on an enforced deny. */
  filter(row: PolicyFilterableRow): boolean;
  /** Emit the aggregated decision summary (no-op with no policy/rows). */
  finish(): void;
  /** Whether a policy context is active (callers can skip work). */
  readonly active: boolean;
}

/**
 * Predicate → policy resolution for the scope gate + PII classing.
 * The registry-backed lookup (PredicateRegistryService.policyFor,
 * partially applied with the tenant) sees operator-authored per-tenant
 * predicates; the static seed fallback only knows CORE_PREDICATES.
 */
export type PredicatePolicyLookup = (predicate: string) => {
  requiresScope?: string;
  piiClass: string;
};

export function makeRowPolicyFilter(opts: {
  callerScopes: readonly string[];
  surface: string;
  /**
   * Explicit context override (simulation). Omit to read the request's
   * context; pass null to force policy-off while keeping the scope gate.
   */
  policy?: PolicyContext | null;
  /**
   * Tenant-aware predicate policy source. Callers on request paths pass
   * the registry-backed lookup so an operator-set requiresScope on a
   * tenant predicate actually fences reads; without it the gate only
   * sees the static code-side seed (the pre-registry behaviour, kept as
   * the fallback for callers with no tenant in hand).
   */
  policyLookup?: PredicatePolicyLookup | undefined;
}): RowPolicyFilter {
  const ctx = opts.policy !== undefined ? opts.policy : getPolicyContext();
  const scopes = opts.callerScopes;
  const lookup: PredicatePolicyLookup = opts.policyLookup ?? policyFor;

  type SetStats = RowDecisionSummary['perSet'][number];
  const perSet = new Map<string, SetStats>();
  let total = 0;
  let evalNs = 0n;

  const filter = (row: PolicyFilterableRow): boolean => {
    const predicatePolicy = lookup(row.predicate);
    if (predicatePolicy.requiresScope && !scopes.includes(predicatePolicy.requiresScope)) {
      return false;
    }
    if (!ctx) return true;

    const t0 = process.hrtime.bigint();
    const view = toRowView(row, (p) => lookup(p).piiClass);
    const evaluation = evaluateRow(ctx, view);
    evalNs += process.hrtime.bigint() - t0;
    total += 1;

    for (const v of evaluation.verdicts) {
      if (v.verdict !== 'deny') continue;
      let stats = perSet.get(v.policySet);
      if (!stats) {
        stats = {
          policySet: v.policySet,
          mode: v.mode,
          denied: 0,
          wouldDeny: 0,
          ruleIds: [],
          sampleFactIds: [],
          samplePredicates: [],
        };
        perSet.set(v.policySet, stats);
      }
      const enforced = v.mode === 'enforce' && !ctx.forceReportOnly;
      if (enforced) stats.denied += 1;
      else stats.wouldDeny += 1;
      const ruleId = v.ruleId ?? 'posture';
      if (!stats.ruleIds.includes(ruleId) && stats.ruleIds.length < SAMPLE_CAP) {
        stats.ruleIds.push(ruleId);
      }
      if (stats.sampleFactIds.length < SAMPLE_CAP && row.id !== undefined) {
        stats.sampleFactIds.push(String(row.id));
        stats.samplePredicates.push(row.predicate);
      }
    }

    return evaluation.decision !== 'deny';
  };

  const finish = (): void => {
    if (!ctx || total === 0) return;
    const summary: RowDecisionSummary = {
      surface: opts.surface,
      total,
      evalSeconds: Number(evalNs) / 1e9,
      perSet: [...perSet.values()],
    };
    getPolicyRowRecorder()?.(summary);
  };

  return { filter, finish, active: ctx !== null && ctx !== undefined };
}
