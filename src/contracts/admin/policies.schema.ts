import { z } from 'zod';

/**
 * Wire contracts for the ABAC admin surface:
 *   /v1/admin/policy-sets (CRUD + attachments)
 *   /v1/admin/policy/explain
 *
 * Mirrors PolicyDocument from src/policy/policy.types.ts, flattened —
 * the wire PolicySet spreads the document fields next to the row
 * metadata (version, timestamps, attachments) so the UI never nests
 * into `.document`. Duplicated in brain-landing/lib/contracts/
 * admin-policies.ts.
 */

export const PolicyMatchConditionSchema = z.object({
  attr: z.string(),
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
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
});

export const PolicyRuleWireSchema = z.object({
  id: z.string(),
  effect: z.enum(['allow', 'deny']),
  kind: z.enum(['action', 'source']),
  enabled: z.boolean(),
  description: z.string().optional(),
  actions: z.array(z.string()).optional(),
  match: z.array(PolicyMatchConditionSchema).optional(),
});

export const PolicySetWireSchema = z.object({
  name: z.string(),
  description: z.string(),
  posture: z.object({
    actions: z.enum(['allow', 'deny']),
    reads: z.enum(['allow', 'deny']),
  }),
  mode: z.enum(['report_only', 'enforce', 'disabled']),
  activeFrom: z.string().nullish(),
  activeUntil: z.string().nullish(),
  rules: z.array(PolicyRuleWireSchema),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  attachedSubjects: z.array(z.string()),
});

export const PolicySetsListResponseSchema = z.object({
  policySets: z.array(PolicySetWireSchema),
});

export const PolicySetResponseSchema = z.object({
  policySet: PolicySetWireSchema,
});

export const PolicySetDeleteResponseSchema = z.object({
  deleted: z.string(),
});

export const PolicyBindingsResponseSchema = z.object({
  bindings: z.array(
    z.object({
      subject: z.string(),
      policyNames: z.array(z.string()),
      updatedAt: z.string(),
    }),
  ),
});

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
});

const SetTraceSchema = z.object({
  policySet: z.string(),
  mode: z.enum(['report_only', 'enforce']),
  verdict: z.enum(['allow', 'deny']),
  decidedBy: z.string(),
  rules: z.array(RuleTraceSchema),
});

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
});

export type PolicySetWire = z.infer<typeof PolicySetWireSchema>;
export type PolicySetsListResponse = z.infer<typeof PolicySetsListResponseSchema>;
export type PolicySetResponse = z.infer<typeof PolicySetResponseSchema>;
export type PolicySetDeleteResponse = z.infer<typeof PolicySetDeleteResponseSchema>;
export type PolicyBindingsResponse = z.infer<typeof PolicyBindingsResponseSchema>;
export type PolicyExplainResponse = z.infer<typeof PolicyExplainResponseSchema>;
