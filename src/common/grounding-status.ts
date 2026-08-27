/**
 * Claim grounding predicate (Drift-1, migration 0115) — the ONE source of
 * truth for "does this fact rest on an observation?". Consumed by the
 * post-resolve stamp (EVIDENCE_GROUNDING_STAMP) on every ingest path; the
 * consolidation gate (EVIDENCE_UNGROUNDED_EXCLUDE) and the serving gate
 * (EVIDENCE_UNGROUNDED_SERVING_GATE) read the STORED column, never
 * recompute — so the definition can only drift here.
 *
 * grounded ⇔ the source names at least one observation:
 *   - `source.episodeIds` contains ≥1 'episode:'-prefixed string (the
 *     episode-record prefix guard, exactly the unionEpisodeIds /
 *     provenance-closure discipline — source is FLEXIBLE, shapes are
 *     never guaranteed), OR
 *   - `source.evidence` is a non-empty array (typed observation pointers,
 *     shape-checked at ingest by evidenceValidationError), OR
 *   - `source.conversationId` is a non-empty string (it names a
 *     conversation that happened — observational; this also keeps every
 *     mention-path fact grounded without the fail-closed capture flag).
 * Else ungrounded.
 *
 * Pure module (episode-ids.ts discipline): no env reads, no IO —
 * importable from the resolver stamp, the runners, and the specs alike.
 */
export type GroundingStatus = 'grounded' | 'ungrounded';

export function groundingStatusOf(source: unknown): GroundingStatus {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return 'ungrounded';
  }
  const s = source as Record<string, unknown>;
  if (
    Array.isArray(s.episodeIds) &&
    s.episodeIds.some((raw) => String(raw).startsWith('episode:'))
  ) {
    return 'grounded';
  }
  if (Array.isArray(s.evidence) && s.evidence.length > 0) return 'grounded';
  if (typeof s.conversationId === 'string' && s.conversationId.length > 0) {
    return 'grounded';
  }
  return 'ungrounded';
}
