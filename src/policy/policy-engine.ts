import { actionKind, actionRuleMatches } from './action-registry';
import {
  CompiledPolicySet,
  CompiledSourceRule,
  PolicyContext,
  PolicyEffect,
  PolicyEvaluation,
  PolicyRowView,
  RuleTrace,
  SetTrace,
  SetVerdict,
} from './policy.types';

/**
 * Pure evaluation core. Deny-overrides within a set (explicit deny >
 * explicit allow > default posture), most-restrictive across sets:
 * the combined decision is ALLOW only when every effective enforce-mode
 * set allows. report_only sets (and all sets under forceReportOnly)
 * contribute would_deny verdicts to the decision stream but never
 * block. No I/O, no clock, no logging — callers own side effects.
 */

/** Exported for the preview-rule sampler (admin simulation surface). */
export function sourceRuleMatches(
  rule: CompiledSourceRule,
  view: PolicyRowView,
): boolean {
  for (const cond of rule.conditions) {
    if (!cond.matches(view)) return false;
  }
  return true;
}

function setVerdictForAction(set: CompiledPolicySet, action: string): SetVerdict {
  const kind = actionKind(action);
  for (const rule of set.actionDeny) {
    if (actionRuleMatches(rule, action, kind)) {
      return { policySet: set.name, mode: set.mode, verdict: 'deny', ruleId: rule.id };
    }
  }
  for (const rule of set.actionAllow) {
    if (actionRuleMatches(rule, action, kind)) {
      return { policySet: set.name, mode: set.mode, verdict: 'allow', ruleId: rule.id };
    }
  }
  return {
    policySet: set.name,
    mode: set.mode,
    verdict: set.posture.actions,
    ruleId: null,
  };
}

function setVerdictForRow(set: CompiledPolicySet, view: PolicyRowView): SetVerdict {
  for (const rule of set.sourceDeny) {
    if (sourceRuleMatches(rule, view)) {
      return { policySet: set.name, mode: set.mode, verdict: 'deny', ruleId: rule.id };
    }
  }
  for (const rule of set.sourceAllow) {
    if (sourceRuleMatches(rule, view)) {
      return { policySet: set.name, mode: set.mode, verdict: 'allow', ruleId: rule.id };
    }
  }
  return {
    policySet: set.name,
    mode: set.mode,
    verdict: set.posture.reads,
    ruleId: null,
  };
}

function combine(
  ctx: PolicyContext,
  verdicts: SetVerdict[],
): PolicyEvaluation {
  let enforcedDeny = false;
  let wouldDeny = false;
  for (const v of verdicts) {
    if (v.verdict !== 'deny') continue;
    if (v.mode === 'enforce' && !ctx.forceReportOnly) enforcedDeny = true;
    else wouldDeny = true;
  }
  const decision = enforcedDeny ? 'deny' : wouldDeny ? 'would_deny' : 'allow';
  return { decision, verdicts };
}

/** Combined action decision across all sets in the context. */
export function evaluateAction(ctx: PolicyContext, action: string): PolicyEvaluation {
  return combine(
    ctx,
    ctx.sets.map((s) => setVerdictForAction(s, action)),
  );
}

/** Combined row decision across all sets in the context. */
export function evaluateRow(ctx: PolicyContext, view: PolicyRowView): PolicyEvaluation {
  return combine(
    ctx,
    ctx.sets.map((s) => setVerdictForRow(s, view)),
  );
}

/**
 * Normalize a retrieved fact row (FactRow or any fact-shaped record)
 * into the attribute view the engine matches on. piiClass comes from
 * the caller's predicate-policy lookup so tenant-registry overrides are
 * honored where available.
 */
export function toRowView(
  row: {
    predicate: string;
    source?: unknown;
    trustSnapshot?: PolicyRowView['trustSnapshot'];
    corroboration?: PolicyRowView['corroboration'];
    userId?: string | null;
  },
  piiClassOf: (predicate: string) => string,
): PolicyRowView {
  return {
    predicate: row.predicate,
    piiClass: piiClassOf(row.predicate),
    source:
      row.source && typeof row.source === 'object'
        ? (row.source as Record<string, unknown>)
        : null,
    trustSnapshot: row.trustSnapshot ?? null,
    corroboration: row.corroboration ?? null,
    userId: row.userId ?? null,
  };
}

// ── Explain (DecisionLog-style traces) ──────────────────────────────────

function traceSourceRule(rule: CompiledSourceRule, view: PolicyRowView): RuleTrace {
  const fields = rule.conditions.map((c) => ({
    attr: c.attr,
    op: c.op,
    expected: c.expected instanceof Set ? [...c.expected] : c.expected,
    actual: c.actual(view),
    matched: c.matches(view),
  }));
  return {
    ruleId: rule.id,
    effect: rule.effect,
    matched: fields.every((f) => f.matched),
    fields,
  };
}

export function explainRow(ctx: PolicyContext, view: PolicyRowView): SetTrace[] {
  return ctx.sets.map((set) => {
    const rules = [...set.sourceDeny, ...set.sourceAllow].map((r) =>
      traceSourceRule(r, view),
    );
    const verdict = setVerdictForRow(set, view);
    return {
      policySet: set.name,
      mode: set.mode,
      verdict: verdict.verdict,
      decidedBy: verdict.ruleId ?? 'posture',
      rules,
    };
  });
}

export function explainAction(ctx: PolicyContext, action: string): SetTrace[] {
  const kind = actionKind(action);
  return ctx.sets.map((set) => {
    const rules: RuleTrace[] = [...set.actionDeny, ...set.actionAllow].map(
      (r) => ({
        ruleId: r.id,
        effect: r.effect as PolicyEffect,
        matched: actionRuleMatches(r, action, kind),
      }),
    );
    const verdict = setVerdictForAction(set, action);
    return {
      policySet: set.name,
      mode: set.mode,
      verdict: verdict.verdict,
      decidedBy: verdict.ruleId ?? 'posture',
      rules,
    };
  });
}
