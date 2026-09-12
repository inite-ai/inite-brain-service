import { z } from 'zod';

/**
 * Wire contracts for the serving-path decision stream (migration 0119):
 *   GET /v1/admin/memory/decisions (+ /stats)
 *
 * The sibling of the ABAC feed in policy-tools.schema.ts, over a
 * different question. That one answers "who was allowed to see what";
 * this one answers "why did the engine abstain, escalate or zoom" —
 * with the policy version that decided it, the alternatives it turned
 * down, and what the choice cost.
 *
 * Rows are content-free by contract (0119): ids, enums and numbers, no
 * query text, no fact text, no answer text. Nothing in these responses
 * can widen that.
 */

export const DecisionKindSchema = z.enum([
  'l3_escalation',
  'abstain',
  'lane_route',
  'zoom',
  'verdict',
]);

/** One decision as served. Optional fields are absent, never null. */
export const MemoryDecisionSchema = z.object({
  decisionId: z.string(),
  decisionKind: DecisionKindSchema,
  policyVersion: z.string(),
  chosenAction: z.string(),
  createdAt: z.string(),
  requestId: z.string().optional(),
  actionScore: z.number().optional(),
  /** Whitelisted signal numbers plus queryClass — the writer's contract. */
  observedState: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
  alternatives: z.array(z.object({ action: z.string(), score: z.number() })).optional(),
  costs: z.record(z.string(), z.number()).optional(),
});

export const MemoryDecisionsResponseSchema = z.object({
  decisions: z.array(MemoryDecisionSchema),
  /** Cursor for the next page: the last row's createdAt. */
  nextCursor: z.string().optional(),
});

/**
 * The aggregate the feed exists for. A decision stream read one row at a
 * time answers nothing; the questions are "how often does the abstain
 * gate fire, under which policy version, and what does escalation cost".
 */
export const MemoryDecisionsStatsResponseSchema = z.object({
  windowDays: z.number(),
  /** Rows scanned — reported so a truncated window is never read as a trend. */
  sampled: z.number(),
  truncated: z.boolean(),
  /** Per (kind, chosenAction): how often, and what it cost on average. */
  byAction: z.array(
    z.object({
      decisionKind: DecisionKindSchema,
      chosenAction: z.string(),
      count: z.number(),
      avgLatencyMs: z.number().optional(),
      avgPromptTokens: z.number().optional(),
      avgCompletionTokens: z.number().optional(),
    }),
  ),
  /** Per policy version: the A/B axis a policy change is read on. */
  byPolicyVersion: z.array(
    z.object({ policyVersion: z.string(), count: z.number(), kinds: z.array(DecisionKindSchema) }),
  ),
  /** Per day, per kind — the shape that shows a regression arriving. */
  series: z.array(z.object({ day: z.string(), counts: z.record(z.string(), z.number()) })),
});

export type MemoryDecision = z.infer<typeof MemoryDecisionSchema>;
export type MemoryDecisionsResponse = z.infer<typeof MemoryDecisionsResponseSchema>;
export type MemoryDecisionsStatsResponse = z.infer<typeof MemoryDecisionsStatsResponseSchema>;
