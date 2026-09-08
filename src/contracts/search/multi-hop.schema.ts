import { z } from 'zod';
import { SearchHitSchema, SearchRequestSchema } from './search.schema';
import {
  CitationSchema,
  SYNTHESIS_GUARDRAILS,
  SynthesisReasonSchema,
  TokenUsageSchema,
} from '../synthesize/synthesize.schema';

/**
 * Wire contracts for POST /v1/search/multi-hop — a planner LLM
 * decomposes the query into ≤ maxHops anchored sub-queries and the
 * executor chains them.
 *
 * Request mirrors MultiHopDto (which extends SearchDto); response
 * mirrors MultiHopResult (src/multi-hop/multi-hop.types.ts). Parity is
 * pinned by test/contracts-multi-hop.unit-spec.ts.
 */

export const MultiHopRequestSchema = SearchRequestSchema.extend({
  /** Planner budget, 1–5 hops. */
  maxHops: z.number().int().min(1).max(5).optional(),
  /** Run the synthesizer over the final entity set and return a grounded answer. */
  synthesize: z.boolean().optional(),
  synthesisGuardrails: z.enum(SYNTHESIS_GUARDRAILS).optional(),
  synthesisModel: z.string().optional(),
});

/** One planned hop, as the planner emitted it. */
export const HopPlanSchema = z.object({
  /** Natural-language sub-query — becomes the `query` of this hop's search. */
  subQuery: z.string(),
  /** Predicate filter; `null` / omitted = no filter. */
  predicates: z.array(z.string()).nullable().optional(),
  /**
   * How the hop combines with the running entity set: `seed` (first
   * hop), `subset_of_previous` (search scoped to the prior set),
   * `intersect` (unconstrained, intersected after) or `union`.
   */
  combination: z.enum(['seed', 'subset_of_previous', 'intersect', 'union']),
  /** Per-hop bitemporal anchor (ISO-8601); the request-level asOf is honoured separately. */
  asOf: z.string().nullable().optional(),
  /** Planner rationale for ops debugging — never affects execution. */
  rationale: z.string().nullable().optional(),
});

export const HopOutcomeSchema = z.object({
  hop: HopPlanSchema,
  /** Entity ids from this hop alone (pre-combination). */
  hopEntityIds: z.array(z.string()),
  /** Running entity set AFTER combining with the prior hop. */
  runningEntityIds: z.array(z.string()),
  hits: z.array(SearchHitSchema),
  /** The SCORED facts this hop returned — no need to walk hits[].facts[]. */
  supportingFactIds: z.array(z.string()),
});

export const MultiHopResponseSchema = z.object({
  /** false when the planner produced a degenerate chain and a single search ran. */
  isMultiHop: z.boolean(),
  hops: z.array(HopOutcomeSchema),
  finalEntityIds: z.array(z.string()),
  finalHits: z.array(SearchHitSchema),
  /**
   * The evidence chain — de-duplicated union of every hop's
   * supportingFactIds in execution order (HotpotQA-style joint-F1 input).
   */
  supportingFactIds: z.array(z.string()),
  /** Present only when the request asked for `synthesize: true`. */
  synthesis: z
    .object({
      answer: z.string().nullable(),
      reason: SynthesisReasonSchema.optional(),
      citations: z.array(CitationSchema),
      tokenUsage: TokenUsageSchema.optional(),
    })
    .optional(),
});

export type MultiHopRequest = z.infer<typeof MultiHopRequestSchema>;
export type MultiHopResponse = z.infer<typeof MultiHopResponseSchema>;
