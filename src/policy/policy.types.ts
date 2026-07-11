import { z } from 'zod';

/**
 * ABAC policy model — the tenant-authored policy document, its zod
 * validation, and the attribute vocabulary rules can match on.
 *
 * A policy set carries ordered-independent rules evaluated
 * deny-overrides: explicit deny > explicit allow > the set's default
 * posture (separately for actions and reads). Multiple sets attached to
 * one key combine most-restrictive: the final verdict is ALLOW only if
 * every enforce-mode set allows. report_only sets are evaluated for the
 * decision stream but never block.
 *
 * The document is stored verbatim in `access_policy.document` (FLEXIBLE)
 * — SurrealDB does not validate it; PolicyDocumentSchema at CRUD time is
 * the sole gate, so keep it strict.
 */

export type PolicyEffect = 'allow' | 'deny';
export type PolicyRuleKind = 'action' | 'source';
export type PolicyMode = 'report_only' | 'enforce' | 'disabled';
export type PolicyPosture = 'allow' | 'deny';
/** would_deny = a report_only (or force-demoted) set would have blocked. */
export type PolicyDecision = 'allow' | 'deny' | 'would_deny';
export type ActionKind = 'read' | 'write' | 'admin';

export type MatchOp =
  | 'eq'
  | 'in'
  | 'prefix'
  | 'gte'
  | 'gt'
  | 'lte'
  | 'lt'
  | 'exists'
  | 'not_exists';

/**
 * Static attribute vocabulary. `source.meta.<key>` is the one dynamic
 * family (operator-supplied document metadata projected onto facts).
 * Everything here is readable straight off a retrieved FactRow — the
 * search legs already SELECT source/trustSnapshot/corroboration, so
 * row evaluation costs no extra queries.
 */
export const POLICY_ATTRIBUTES: Record<
  string,
  { type: 'string' | 'number' | 'boolean'; ops: MatchOp[]; description: string }
> = {
  predicate: {
    type: 'string',
    ops: ['eq', 'in', 'prefix'],
    description: 'Fact predicate id (tenant predicate registry)',
  },
  piiClass: {
    type: 'string',
    ops: ['eq', 'in'],
    description: 'PII class of the predicate (none/identifier/behavioral/text/sensitive)',
  },
  'source.vertical': {
    type: 'string',
    ops: ['eq', 'in'],
    description: 'Ingest vertical the fact arrived through',
  },
  'source.recorder': {
    type: 'string',
    ops: ['eq', 'in'],
    description: 'Recorder / connector that wrote the fact',
  },
  'source.documentId': {
    type: 'string',
    ops: ['eq', 'in'],
    description: 'Originating source_document id (doc-pipeline facts)',
  },
  'source.originKey': {
    type: 'string',
    ops: ['eq', 'in', 'prefix'],
    description: 'Origin identity key (doc:<hash> or vertical:recorder)',
  },
  'trust.authority': {
    type: 'number',
    ops: ['gte', 'gt', 'lte', 'lt'],
    description: 'Write-time source authority (0..1, trustSnapshot)',
  },
  'trust.declaredTrust': {
    type: 'number',
    ops: ['gte', 'gt', 'lte', 'lt'],
    description: 'Declared source trust at write time (0..1)',
  },
  'trust.learnedTrust': {
    type: 'number',
    ops: ['gte', 'gt', 'lte', 'lt'],
    description: 'Learned source trust at write time (0..1)',
  },
  'corroboration.count': {
    type: 'number',
    ops: ['gte', 'gt', 'lte', 'lt'],
    description: 'Distinct corroborating origins',
  },
  'provenance.purged': {
    type: 'boolean',
    ops: ['eq'],
    description: 'Originating document text has been erased',
  },
  userId: {
    type: 'string',
    ops: ['eq', 'in', 'exists', 'not_exists'],
    description: 'Per-user memory scope owner (0055); absent = tenant-global',
  },
};

const SOURCE_META_ATTR = /^source\.meta\.[a-z][a-z0-9_]{0,63}$/;
const META_ATTR_OPS: MatchOp[] = ['eq', 'in', 'exists', 'not_exists'];

export function attributeSpec(
  attr: string,
): { type: 'string' | 'number' | 'boolean'; ops: MatchOp[] } | null {
  const fixed = POLICY_ATTRIBUTES[attr];
  if (fixed) return fixed;
  if (SOURCE_META_ATTR.test(attr)) return { type: 'string', ops: META_ATTR_OPS };
  return null;
}

export const POLICY_MACROS = ['@readonly', '@write', '@all'] as const;
export type PolicyMacro = (typeof POLICY_MACROS)[number];

// ── zod document schema ─────────────────────────────────────────────────

const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SET_NAME = /^[a-z][a-z0-9_-]{1,63}$/;
const ACTION_NAME = /^(@[a-z]+|[a-z][a-z0-9_.-]{0,127})$/;

export const MAX_RULES_PER_SET = 64;
export const MAX_VALUES_PER_LIST = 128;
export const MAX_DOCUMENT_BYTES = 32 * 1024;
export const MAX_SETS_PER_KEY = 8;

const MatchConditionSchema = z
  .object({
    attr: z.string().max(96),
    op: z.enum([
      'eq',
      'in',
      'prefix',
      'gte',
      'gt',
      'lte',
      'lt',
      'exists',
      'not_exists',
    ]),
    value: z
      .union([
        z.string().max(256),
        z.number().finite(),
        z.boolean(),
        z.array(z.string().max(256)).min(1).max(MAX_VALUES_PER_LIST),
      ])
      .optional(),
  })
  .superRefine((cond, ctx) => {
    const spec = attributeSpec(cond.attr);
    if (!spec) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown attribute '${cond.attr}'`,
        path: ['attr'],
      });
      return;
    }
    if (!spec.ops.includes(cond.op)) {
      ctx.addIssue({
        code: 'custom',
        message: `Operator '${cond.op}' not valid for '${cond.attr}' (allowed: ${spec.ops.join(', ')})`,
        path: ['op'],
      });
      return;
    }
    if (cond.op === 'exists' || cond.op === 'not_exists') {
      if (cond.value !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `Operator '${cond.op}' takes no value`,
          path: ['value'],
        });
      }
      return;
    }
    if (cond.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `Operator '${cond.op}' requires a value`,
        path: ['value'],
      });
      return;
    }
    const v = cond.value;
    const scalarOk =
      spec.type === 'number'
        ? typeof v === 'number'
        : spec.type === 'boolean'
          ? typeof v === 'boolean'
          : typeof v === 'string';
    if (cond.op === 'in') {
      if (!Array.isArray(v)) {
        ctx.addIssue({
          code: 'custom',
          message: `Operator 'in' requires an array of strings`,
          path: ['value'],
        });
      } else if (spec.type !== 'string') {
        ctx.addIssue({
          code: 'custom',
          message: `Operator 'in' only applies to string attributes`,
          path: ['value'],
        });
      }
      return;
    }
    if (Array.isArray(v) || !scalarOk) {
      ctx.addIssue({
        code: 'custom',
        message: `Value type does not match attribute type '${spec.type}'`,
        path: ['value'],
      });
    }
  });

const PolicyRuleSchema = z
  .object({
    id: z.string().regex(RULE_ID),
    effect: z.enum(['allow', 'deny']),
    kind: z.enum(['action', 'source']),
    enabled: z.boolean().default(true),
    description: z.string().max(300).optional(),
    actions: z
      .array(z.string().regex(ACTION_NAME))
      .min(1)
      .max(MAX_VALUES_PER_LIST)
      .optional(),
    match: z.array(MatchConditionSchema).min(1).max(16).optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.kind === 'action') {
      if (!rule.actions) {
        ctx.addIssue({
          code: 'custom',
          message: `kind=action rule requires 'actions'`,
          path: ['actions'],
        });
      }
      if (rule.match) {
        ctx.addIssue({
          code: 'custom',
          message: `kind=action rule cannot carry 'match'`,
          path: ['match'],
        });
      }
      for (const a of rule.actions ?? []) {
        if (a.startsWith('@') && !POLICY_MACROS.includes(a as PolicyMacro)) {
          ctx.addIssue({
            code: 'custom',
            message: `Unknown macro '${a}' (known: ${POLICY_MACROS.join(', ')})`,
            path: ['actions'],
          });
        }
      }
    } else {
      if (!rule.match) {
        ctx.addIssue({
          code: 'custom',
          message: `kind=source rule requires 'match'`,
          path: ['match'],
        });
      }
      if (rule.actions) {
        ctx.addIssue({
          code: 'custom',
          message: `kind=source rule cannot carry 'actions'`,
          path: ['actions'],
        });
      }
    }
  });

export const PolicyDocumentSchema = z
  .object({
    name: z.string().regex(SET_NAME),
    description: z.string().max(500).default(''),
    posture: z.object({
      actions: z.enum(['allow', 'deny']),
      reads: z.enum(['allow', 'deny']),
    }),
    mode: z.enum(['report_only', 'enforce', 'disabled']),
    activeFrom: z.iso.datetime().nullish(),
    activeUntil: z.iso.datetime().nullish(),
    rules: z.array(PolicyRuleSchema).max(MAX_RULES_PER_SET).default([]),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    for (const r of doc.rules) {
      if (ids.has(r.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate rule id '${r.id}'`,
          path: ['rules'],
        });
      }
      ids.add(r.id);
    }
    if (JSON.stringify(doc).length > MAX_DOCUMENT_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `Policy document exceeds ${MAX_DOCUMENT_BYTES} bytes`,
      });
    }
    // A window with activeFrom >= activeUntil never opens — the set would
    // be permanently inert (compile-time drop), which fails OPEN. Reject
    // it at write time rather than silently accept a dead policy.
    if (doc.activeFrom && doc.activeUntil) {
      if (new Date(doc.activeFrom).getTime() >= new Date(doc.activeUntil).getTime()) {
        ctx.addIssue({
          code: 'custom',
          message: 'activeFrom must be strictly before activeUntil',
          path: ['activeFrom'],
        });
      }
    }
  });

export type MatchCondition = z.infer<typeof MatchConditionSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

// ── Evaluation shapes ───────────────────────────────────────────────────

/**
 * Normalized per-row attribute view. Built once per row from a FactRow
 * (or any fact-shaped record) — the engine never touches raw rows.
 */
export interface PolicyRowView {
  predicate: string;
  piiClass: string;
  source?: Record<string, unknown> | null;
  trustSnapshot?: {
    authority?: number;
    declaredTrust?: number;
    learnedTrust?: number;
  } | null;
  corroboration?: { count?: number } | null;
  userId?: string | null;
}

export interface CompiledActionRule {
  id: string;
  effect: PolicyEffect;
  /** Exact action names, macros pre-split. */
  names: Set<string>;
  macros: Set<PolicyMacro>;
}

export interface CompiledSourceRule {
  id: string;
  effect: PolicyEffect;
  conditions: CompiledCondition[];
}

export interface CompiledCondition {
  attr: string;
  op: MatchOp;
  /** Pre-normalized: Set for eq/in on strings, scalar otherwise. */
  expected: Set<string> | string | number | boolean | null;
  matches(view: PolicyRowView): boolean;
  /** Actual value read from the view — for explain traces. */
  actual(view: PolicyRowView): unknown;
}

export interface CompiledPolicySet {
  name: string;
  mode: Exclude<PolicyMode, 'disabled'>;
  posture: { actions: PolicyPosture; reads: PolicyPosture };
  /** Deny rules first — evaluation order is fixed by effect, not array order. */
  actionDeny: CompiledActionRule[];
  actionAllow: CompiledActionRule[];
  sourceDeny: CompiledSourceRule[];
  sourceAllow: CompiledSourceRule[];
  document: PolicyDocument;
}

/**
 * Per-request policy context attached to req.brainAuth. null context
 * (no ABAC / no sets referenced) short-circuits every enforcement
 * point to today's exact behavior.
 */
export interface PolicyContext {
  companyId: string;
  keyHash: string;
  sets: CompiledPolicySet[];
  /** ABAC_FORCE_REPORT_ONLY — treat every enforce set as report_only. */
  forceReportOnly: boolean;
  /**
   * Fail-closed sentinel: a referenced set name did not resolve. The
   * resolver injects a synthetic enforce deny-all set; this flag marks
   * the condition for logs/metrics.
   */
  resolutionError: boolean;
}

/** Verdict of one set for one action/row, before cross-set combination. */
export interface SetVerdict {
  policySet: string;
  mode: Exclude<PolicyMode, 'disabled'>;
  verdict: PolicyEffect;
  /** Rule that decided it; null = default posture. */
  ruleId: string | null;
}

export interface PolicyEvaluation {
  /** Final combined decision across enforce-mode sets. */
  decision: PolicyDecision;
  /** Per-set verdicts (enforce and report_only alike). */
  verdicts: SetVerdict[];
}

/** Explain trace, DecisionLog-style: additive, per-rule field detail. */
export interface RuleTrace {
  ruleId: string;
  effect: PolicyEffect;
  matched: boolean;
  fields?: Array<{
    attr: string;
    op: MatchOp;
    expected: unknown;
    actual: unknown;
    matched: boolean;
  }>;
}

export interface SetTrace {
  policySet: string;
  mode: Exclude<PolicyMode, 'disabled'>;
  verdict: PolicyEffect;
  decidedBy: string | 'posture';
  rules: RuleTrace[];
}
