import { z } from 'zod';

/**
 * Wire contracts for the belief read API (Belief-B: GET /v1/beliefs/:id,
 * GET /v1/beliefs — BELIEFS_API_ENABLED, default off → 404). Serves the
 * semantic_belief substrate (migration 0120) written by the Belief-A
 * promotion pass. Runtime parity with the service result types is
 * pinned by test/contracts-beliefs.unit-spec.ts.
 */

export const BeliefReadResponseSchema = z.object({
  beliefId: z.string(),
  /**
   * The single-user scope the promotion stamped (#387 fence: a belief
   * always inherits its scenes' one user — never tenant-global).
   */
  userId: z.string(),
  /** FREE-TEXT (subject, field) key from scene stateDeltas — deliberately
   *  NOT entity-resolved (the 0120 SemanticBelief/Claim separation). */
  subject: z.string(),
  field: z.string(),
  /** The held value. */
  value: z.string(),
  /** The value this revision displaced; absent on an unknown prior. */
  priorValue: z.string().optional(),
  /** Rendered statement ('template' fold or optional 'llm' phrasing). */
  statement: z.string(),
  statementSource: z.enum(['template', 'llm']),
  confidence: z.number(),
  /** Supersede-chain position (revision N+1 displaces N, never in-place). */
  revision: z.number(),
  /** Bitemporal lifecycle (the 0047 vocabulary subset): 'active' or
   *  'superseded'. String, not enum — additive-friendly on widening. */
  status: z.string(),
  /** Record id of the displacing revision; absent while active. */
  supersededBy: z.string().optional(),
  validFrom: z.string(),
  validUntil: z.string().optional(),
  /** Inline canonical provenance: the promoted scene record ids. */
  sourceSceneIds: z.array(z.string()),
  /** Distinct conversations behind those scenes. */
  conversationIds: z.array(z.string()),
  /** Corroboration counters (in-place updatable by contract). */
  corroborationCount: z.number(),
  conversationCount: z.number(),
  /** Readable promoter|world composite stamped by the promotion pass. */
  promoterVersion: z.string().optional(),
});

export const BeliefsListResponseSchema = z.object({
  /** Beliefs visible to the caller after every fence, page-capped. */
  beliefs: z.array(BeliefReadResponseSchema),
  /** Rows returned (NOT a total count — the page size after fencing). */
  found: z.number(),
});

export type BeliefReadResponse = z.infer<typeof BeliefReadResponseSchema>;
export type BeliefsListResponse = z.infer<typeof BeliefsListResponseSchema>;
