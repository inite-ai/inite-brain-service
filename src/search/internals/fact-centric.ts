import type { EntityBucket } from './types';

/**
 * Fact-centric selection (SEARCH_FACT_CENTRIC_ENABLED) — Phase A of the
 * typed-memory roadmap (docs/roadmap/locomo-sota-architecture-2026-07.md).
 *
 * The default pipeline ranks ENTITIES and slices to `limit`, so a
 * high-scoring fact on entity #11 is unreachable no matter how relevant
 * it is — the measured dominant failure on single-hop QA (the gold fact
 * exists but its entity missed the gate). Under the flag, facts compete
 * globally instead: flatten every scored row across ALL buckets, keep
 * the top `budget` by fact score, and rebuild pruned buckets ordered by
 * their best selected fact (Map insertion order — the flatten is sorted
 * best-first, so an entity's first appearance IS its best fact).
 *
 * The hit shape is unchanged; only selection changes. Backfill is
 * skipped by the caller under this flag — the global score cut replaces
 * the per-entity recency padding.
 */
export function selectFactCentric(
  buckets: EntityBucket[],
  budget: number,
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
  for (const { bucket, row } of flat.slice(0, Math.max(1, budget))) {
    let nb = rebuilt.get(bucket.entityId);
    if (!nb) {
      nb = { ...bucket, facts: [] };
      rebuilt.set(bucket.entityId, nb);
    }
    nb.facts.push(row);
  }
  return [...rebuilt.values()];
}
