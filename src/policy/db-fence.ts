import { CompiledCondition, PolicyContext } from './policy.types';

/**
 * Pushdown compiler for the DB-level fence (migration 0057,
 * ABAC_DB_FENCE_ENABLED). Extracts the DENY-EQUALITY SUBSET of the
 * request's enforce-mode rules into the shape
 * fn::policy_row_denied expects on `$caller_policy_deny`.
 *
 * A rule is pushdown-safe only when EVERY condition is an eq/in match
 * on a pushdownable attribute — pushing a partial rule would create
 * false-positive denials at the DB that the app layer would allow.
 * Skipping a rule is always safe: the app-layer filter remains the
 * authoritative gate; the DB fence only has to catch forgotten-filter
 * leaks with NONE values instead of data.
 */

const PUSHDOWN_ATTRS: Record<string, keyof DenyPushdownRule> = {
  predicate: 'predicate',
  'source.vertical': 'vertical',
  'source.recorder': 'recorder',
  'source.documentId': 'documentId',
  'source.originKey': 'originKey',
};

export interface DenyPushdownRule {
  predicate?: string[];
  vertical?: string[];
  recorder?: string[];
  documentId?: string[];
  originKey?: string[];
}

export function compileDenyPushdown(ctx: PolicyContext | undefined): DenyPushdownRule[] {
  if (!ctx || ctx.forceReportOnly) return [];
  const out: DenyPushdownRule[] = [];
  for (const set of ctx.sets) {
    if (set.mode !== 'enforce') continue;
    for (const rule of set.sourceDeny) {
      const pushed: DenyPushdownRule = {};
      let pushable = rule.conditions.length > 0;
      for (const cond of rule.conditions) {
        const key = PUSHDOWN_ATTRS[cond.attr];
        const values = equalityValues(cond);
        if (!key || values === null) {
          pushable = false;
          break;
        }
        // Two conditions on the same attr AND together — a single
        // rule row can't express that; keep it app-layer only.
        if (pushed[key]) {
          pushable = false;
          break;
        }
        pushed[key] = values;
      }
      if (pushable && Object.keys(pushed).length > 0) out.push(pushed);
    }
  }
  return out;
}

function equalityValues(cond: CompiledCondition): string[] | null {
  if (cond.op === 'eq' && typeof cond.expected === 'string') {
    return [cond.expected];
  }
  if (cond.op === 'in' && cond.expected instanceof Set) {
    return [...cond.expected];
  }
  return null;
}
