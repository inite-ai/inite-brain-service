import { z } from 'zod';

/**
 * Wire contracts for the fact read + provenance API
 * (GET /v1/facts/:id, GET /v1/facts/:id/provenance — FACTS_API_ENABLED,
 * default off → 404). Runtime parity with the service result types is
 * pinned by test/contracts-facts.unit-spec.ts.
 */

export const FactReadResponseSchema = z.object({
  factId: z.string(),
  /** The fact's predicate — what the memory is ABOUT. */
  aspect: z.string(),
  /** The fact's object — what is remembered. */
  statement: z.string(),
  confidence: z.number(),
  validFrom: z.string(),
  /** Per-user scope key (migration 0055); absent = tenant-global. */
  userId: z.string().optional(),
  /** source.kind when the deriver stamped one (typed atoms). */
  kind: z.string().optional(),
  vertical: z.string().optional(),
  recorder: z.string().optional(),
  conversationId: z.string().optional(),
  retracted: z.boolean(),
  derivedVersion: z.string().optional(),
  /**
   * Claim grounding state (Drift-1, migration 0115): 'grounded' = the
   * source names an observation (episode ids / evidence[] /
   * conversationId); 'ungrounded' = explicitly marked observation-free.
   * Absent = legacy row (predates the EVIDENCE_GROUNDING_STAMP writer) —
   * additive, backward-compatible.
   */
  groundingStatus: z.enum(['grounded', 'ungrounded']).optional(),
});

export const FactProvenanceEpisodeSchema = z.object({
  episodeId: z.string(),
  conversationId: z.string().optional(),
  speaker: z.string().optional(),
  occurredAt: z.string(),
  /** Verbatim turn text, capped server-side. */
  text: z.string(),
  /**
   * G3 char-span grounding quote (DERIVER_SPANS worlds only). Offsets
   * are Unicode CODE POINTS over the NFC-normalized FULL stored episode
   * text — not UTF-16 units, and not the capped `text` field (see
   * textTruncated). Optional → backward-compatible.
   */
  span: z
    .object({
      start: z.number(),
      end: z.number(),
      exact: z.string(),
    })
    .optional(),
  /** Present with `span`: true when `text` was truncated by the server
   *  cap — span offsets reference the FULL stored text. */
  textTruncated: z.boolean().optional(),
});

export const FactProvenanceResponseSchema = z.object({
  factId: z.string(),
  /** Grounding turns (source.episodeIds), chronological. */
  episodes: z.array(FactProvenanceEpisodeSchema),
  /**
   * Recursive support closure (PROVENANCE_RECURSIVE_CLOSURE, default
   * off): the facts this fact was derived from, transitively, with
   * their derivedFrom distance and lifecycle status (compacted /
   * retracted members still witness — status is reported, not hidden).
   * Absent (not empty) when the flag is off or the fact has no
   * derivedFrom → backward-compatible.
   */
  derivedFacts: z
    .array(
      z.object({
        factId: z.string(),
        predicate: z.string(),
        depth: z.number(),
        status: z.string(),
      }),
    )
    .optional(),
  /**
   * Closure walk summary: deepest hop reached, supporting-fact count,
   * whether a depth/fan-out/episode cap truncated the walk, and whether
   * a visibility fence silently dropped ≥1 member. Absent with the flag
   * off → backward-compatible.
   */
  closure: z
    .object({
      depth: z.number(),
      factCount: z.number(),
      truncated: z.boolean(),
      filtered: z.boolean(),
    })
    .optional(),
  /**
   * Typed support edges crossed by the walk
   * (PROVENANCE_SUPPORT_GRAPH_READ, migration 0116): supported_by
   * (fact -> scene), contradicted_by (loser fact -> winner fact),
   * derived_from (summary fact -> member fact). `from`/`to` are full
   * record ids. Absent (not empty) when the read flag is off →
   * backward-compatible.
   */
  supportEdges: z
    .array(
      z.object({
        kind: z.enum(['supported_by', 'contradicted_by', 'derived_from']),
        from: z.string(),
        to: z.string(),
      }),
    )
    .optional(),
});

export type FactReadResponse = z.infer<typeof FactReadResponseSchema>;
export type FactProvenanceResponse = z.infer<typeof FactProvenanceResponseSchema>;
