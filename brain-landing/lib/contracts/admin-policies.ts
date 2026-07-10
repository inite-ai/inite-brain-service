import { z } from 'zod'

/**
 * Wire contracts for the ABAC admin surface.
 *
 * **Duplicate** of src/contracts/admin/policies.schema.ts and
 * src/contracts/admin/policy-tools.schema.ts.
 */

export const MatchOpSchema = z.enum([
  'eq',
  'in',
  'prefix',
  'gte',
  'gt',
  'lte',
  'lt',
  'exists',
  'not_exists',
])

export const PolicyMatchConditionSchema = z.object({
  attr: z.string(),
  op: MatchOpSchema,
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
})

export const PolicyRuleSchema = z.object({
  id: z.string(),
  effect: z.enum(['allow', 'deny']),
  kind: z.enum(['action', 'source']),
  enabled: z.boolean(),
  description: z.string().optional(),
  actions: z.array(z.string()).optional(),
  match: z.array(PolicyMatchConditionSchema).optional(),
})

export const PolicySetSchema = z.object({
  name: z.string(),
  description: z.string(),
  posture: z.object({
    actions: z.enum(['allow', 'deny']),
    reads: z.enum(['allow', 'deny']),
  }),
  mode: z.enum(['report_only', 'enforce', 'disabled']),
  activeFrom: z.string().nullish(),
  activeUntil: z.string().nullish(),
  rules: z.array(PolicyRuleSchema),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  attachedSubjects: z.array(z.string()),
})

export const PolicySetsListResponseSchema = z.object({
  policySets: z.array(PolicySetSchema),
})
export const PolicySetResponseSchema = z.object({ policySet: PolicySetSchema })
export const PolicySetDeleteResponseSchema = z.object({ deleted: z.string() })
export const PolicyBindingsResponseSchema = z.object({
  bindings: z.array(
    z.object({
      subject: z.string(),
      policyNames: z.array(z.string()),
      updatedAt: z.string(),
    }),
  ),
})

const RuleTraceSchema = z.object({
  ruleId: z.string(),
  effect: z.enum(['allow', 'deny']),
  matched: z.boolean(),
  fields: z
    .array(
      z.object({
        attr: z.string(),
        op: z.string(),
        expected: z.unknown(),
        actual: z.unknown(),
        matched: z.boolean(),
      }),
    )
    .optional(),
})

const SetTraceSchema = z.object({
  policySet: z.string(),
  mode: z.enum(['report_only', 'enforce']),
  verdict: z.enum(['allow', 'deny']),
  decidedBy: z.string(),
  rules: z.array(RuleTraceSchema),
})

export const PolicyExplainResponseSchema = z.object({
  action: z
    .object({
      name: z.string(),
      decision: z.enum(['allow', 'deny', 'would_deny']),
      traces: z.array(SetTraceSchema),
    })
    .optional(),
  row: z
    .object({
      factId: z.string(),
      decision: z.enum(['allow', 'deny', 'would_deny']),
      traces: z.array(SetTraceSchema),
      view: z.object({
        predicate: z.string(),
        piiClass: z.string(),
        source: z.record(z.string(), z.unknown()).nullable(),
        trustSnapshot: z.record(z.string(), z.unknown()).nullable(),
        corroboration: z.record(z.string(), z.unknown()).nullable(),
        userId: z.string().nullable(),
      }),
    })
    .optional(),
})

// ── Tooling (registry / simulate / decisions / keys) ────────────────────

export const PolicyRegistryResponseSchema = z.object({
  actions: z.array(
    z.object({
      name: z.string(),
      family: z.string(),
      kind: z.enum(['read', 'write', 'admin']),
      title: z.string().optional(),
    }),
  ),
  macros: z.array(z.object({ id: z.string(), actions: z.array(z.string()) })),
  attributes: z.array(
    z.object({
      attr: z.string(),
      type: z.enum(['string', 'number', 'boolean']),
      ops: z.array(z.string()),
      description: z.string(),
      values: z.array(z.string()).optional(),
    }),
  ),
  dynamicAttributes: z.array(
    z.object({
      prefix: z.string(),
      type: z.literal('string'),
      ops: z.array(z.string()),
      description: z.string(),
    }),
  ),
})

const DecisionSchema = z.enum(['allow', 'deny', 'would_deny'])

const ReasonSchema = z.object({
  policySet: z.string(),
  ruleId: z.string().nullable(),
  effect: z.enum(['allow', 'deny']),
  kind: z.enum(['action', 'source', 'posture']),
  detail: z.string(),
})

export const SimulateSearchResponseSchema = z.object({
  summary: z.object({
    total: z.number(),
    visible: z.number(),
    denied: z.number(),
    wouldDeny: z.number(),
  }),
  rows: z.array(
    z.object({
      factId: z.string(),
      entityId: z.string(),
      entityType: z.string(),
      canonicalName: z.string(),
      predicate: z.string(),
      object: z.string(),
      confidence: z.number(),
      score: z.number(),
      source: z.object({
        vertical: z.string().optional(),
        recorder: z.string().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
      decision: DecisionSchema,
      reasons: z.array(ReasonSchema),
    }),
  ),
})

export const SimulateActionsResponseSchema = z.object({
  actions: z.array(
    z.object({
      name: z.string(),
      family: z.string(),
      kind: z.string(),
      decision: DecisionSchema,
      reasons: z.array(ReasonSchema),
    }),
  ),
})

export const PreviewRuleResponseSchema = z.object({
  matched: z.number(),
  sampled: z.number(),
  sample: z.array(
    z.object({
      factId: z.string(),
      predicate: z.string(),
      source: z.object({
        vertical: z.string().optional(),
        recorder: z.string().optional(),
      }),
    }),
  ),
})

export const PolicyDecisionsResponseSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string(),
      ts: z.string(),
      keyId: z.string(),
      kind: z.enum(['action', 'row']),
      decision: DecisionSchema,
      mode: z.enum(['report_only', 'enforce']),
      action: z.string().optional(),
      policySet: z.string().optional(),
      ruleId: z.string().optional(),
      requestId: z.string().optional(),
      rowCounts: z
        .object({ total: z.number(), denied: z.number() })
        .optional(),
      samplePredicates: z.array(z.string()).optional(),
      sampled: z.boolean(),
    }),
  ),
  nextCursor: z.string().optional(),
})

export const PolicyDecisionsStatsResponseSchema = z.object({
  windowDays: z.number(),
  series: z.array(
    z.object({
      day: z.string(),
      allow: z.number(),
      deny: z.number(),
      wouldDeny: z.number(),
    }),
  ),
  topDeniedActions: z.array(
    z.object({ action: z.string(), count: z.number() }),
  ),
  topRules: z.array(
    z.object({ policySet: z.string(), ruleId: z.string(), count: z.number() }),
  ),
  byKey: z.array(
    z.object({ keyId: z.string(), deny: z.number(), wouldDeny: z.number() }),
  ),
  reportOnlySets: z.array(
    z.object({
      name: z.string(),
      sinceDays: z.number(),
      wouldDeny: z.number(),
    }),
  ),
  truncated: z.boolean(),
})

export const AdminKeysResponseSchema = z.object({
  keys: z.array(
    z.object({
      keyId: z.string(),
      subject: z.string(),
      name: z.string().optional(),
      scopes: z.array(z.string()),
      policySets: z.array(z.object({ name: z.string(), mode: z.string() })),
    }),
  ),
})

export type MatchOp = z.infer<typeof MatchOpSchema>
export type PolicyMatchCondition = z.infer<typeof PolicyMatchConditionSchema>
export type PolicyRule = z.infer<typeof PolicyRuleSchema>
export type PolicySet = z.infer<typeof PolicySetSchema>
export type PolicySetsListResponse = z.infer<typeof PolicySetsListResponseSchema>
export type PolicySetResponse = z.infer<typeof PolicySetResponseSchema>
export type PolicyExplainResponse = z.infer<typeof PolicyExplainResponseSchema>
export type PolicyRegistryResponse = z.infer<typeof PolicyRegistryResponseSchema>
export type SimulateSearchResponse = z.infer<typeof SimulateSearchResponseSchema>
export type SimulateActionsResponse = z.infer<typeof SimulateActionsResponseSchema>
export type PreviewRuleResponse = z.infer<typeof PreviewRuleResponseSchema>
export type PolicyDecisionsResponse = z.infer<typeof PolicyDecisionsResponseSchema>
export type PolicyDecisionsStatsResponse = z.infer<
  typeof PolicyDecisionsStatsResponseSchema
>
export type AdminKeysResponse = z.infer<typeof AdminKeysResponseSchema>
export type Decision = z.infer<typeof DecisionSchema>
export type SimulationReason = z.infer<typeof ReasonSchema>
