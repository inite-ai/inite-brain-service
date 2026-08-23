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
});

export type FactReadResponse = z.infer<typeof FactReadResponseSchema>;
export type FactProvenanceResponse = z.infer<
  typeof FactProvenanceResponseSchema
>;
