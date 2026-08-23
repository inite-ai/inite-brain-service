import type { EntityBucket } from './types';

/**
 * Fact-centric selection — Phase A of the
 * typed-memory roadmap (docs/roadmap/locomo-sota-architecture-2026-07.md).
 *
 * The old pipeline ranked ENTITIES and sliced to `limit`, so a
 * high-scoring fact on entity #11 was unreachable no matter how relevant
 * it was — the measured dominant failure on single-hop QA (the gold fact
 * exists but its entity missed the gate). Facts compete globally
 * instead: flatten every scored row across ALL buckets, keep
 * the top `budget` by fact score, and rebuild pruned buckets ordered by
 * their best selected fact (Map insertion order — the flatten is sorted
 * best-first, so an entity's first appearance IS its best fact).
 *
 * The hit shape is unchanged; only selection changes. The global score
 * cut replaces the old per-entity recency backfill.
 *
 * Audit W4 #15: this used to OVERWRITE the reranked window wholesale —
 * the cross-encoder + LLM rerank ran, was paid for, and its order was
 * discarded, PPR's lift went with it, and nothing re-sliced to `limit`
 * (a caller asking for 10 entities got up to `budget` = 48). Selection
 * is now layered over the ranking instead of replacing it: facts still
 * compete globally, but the surviving buckets keep the reranked order
 * where the reranker had an opinion, and the caller's limit is honored.
 */
export function selectFactCentric(
  buckets: EntityBucket[],
  budget: number,
  opts: {
    /** Entity ids in reranked order — the ranking to preserve. */
    priority?: string[];
    /** Caller's entity limit; omitted → no slice (legacy behaviour). */
    limit?: number;
  } = {},
): EntityBucket[] {
  const flat: Array<{
    bucket: EntityBucket;
    row: EntityBucket['facts'][number];
  }> = [];
  for (const b of buckets) {
    for (const row of b.facts) flat.push({ bucket: b, row });
  }
  flat.sort((a, b) => b.row.score - a.row.score);
  const rebuilt = new Map<string, EntityBucket>();
  // Best selected fact per entity — the ordering key for buckets the
  // reranker never saw (it only ranks a bounded window).
  const bestScore = new Map<string, number>();
  for (const { bucket, row } of flat.slice(0, Math.max(1, budget))) {
    let nb = rebuilt.get(bucket.entityId);
    if (!nb) {
      nb = { ...bucket, facts: [] };
      rebuilt.set(bucket.entityId, nb);
      bestScore.set(bucket.entityId, row.score);
    }
    nb.facts.push(row);
  }

  const rank = new Map<string, number>();
  (opts.priority ?? []).forEach((id, i) => rank.set(id, i));
  const ordered = [...rebuilt.values()].sort((a, b) => {
    const ra = rank.get(a.entityId) ?? Number.POSITIVE_INFINITY;
    const rb = rank.get(b.entityId) ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return (bestScore.get(b.entityId) ?? 0) - (bestScore.get(a.entityId) ?? 0);
  });
  return opts.limit !== undefined && opts.limit > 0 ? ordered.slice(0, opts.limit) : ordered;
}
