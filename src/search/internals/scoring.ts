import { policyFor } from '../../ingest/conflict-resolver';
import type { FusedRow, ScoredRow, EntityBucket } from './types';
import { diversityKey } from './diversity-key';

// Per-predicate boost α. Most predicates use the soft default
// (0.5 → max 1.5x boost) — a strong embedding hit on the wrong class
// can still beat a weak hit on the right one. PII-class discriminators
// (dob, email, phone) use a stronger α (1.5) because they're high-
// cardinality identifiers — when the router says "this is a dob lookup",
// the dob fact MUST surface above the name fact for the same entity.
// Address uses 0.8 — between the two — because address-vs-name
// disambiguation is real but less stark than dob-vs-name.
//
// Empirical anchor: per-predicate eval reported dob match-rate
// 0.30 → 0.60 after the prompt patch, still 40% miss; raising α here
// is the second half of the fix.
const PREDICATE_BOOST_ALPHA: Record<string, number> = {
  dob: 1.5,
  email: 1.5,
  phone: 1.5,
  address: 0.8,
};
const PREDICATE_BOOST_ALPHA_DEFAULT = 0.5;

const DEGREE_BOOST_WEIGHT = 0.3;
const DEGREE_BOOST_TOP_N = 2;

export interface PredicateDistribution {
  weights: Record<string, number>;
}

/**
 * Decay × confidence × predicate-boost scoring for each fused row.
 * Pure — `now` is passed in so tests stay deterministic.
 *
 *   score = fusedScore × exp(-ln2 × ageDays / halfLife) × confidence
 *           × (1 + α × predicateDist.weights[predicate])
 *
 * `predicateDist` null → boost reduces to 1.0. `policy.decayHalfLifeDays`
 * null → no decay (1.0).
 */
export function scoreRows(
  rows: FusedRow[],
  predicateDist: PredicateDistribution | null,
  now: number,
): ScoredRow[] {
  return rows.map((row) => {
    const policy = policyFor(row.predicate);
    const ageDays = (now - new Date(row.recordedAt).getTime()) / 86_400_000;
    const decay =
      policy.decayHalfLifeDays === null
        ? 1
        : Math.exp((-Math.LN2 * ageDays) / policy.decayHalfLifeDays);
    const alpha =
      PREDICATE_BOOST_ALPHA[row.predicate] ?? PREDICATE_BOOST_ALPHA_DEFAULT;
    const predBoost = predicateDist
      ? 1 + alpha * (predicateDist.weights[row.predicate] ?? 0)
      : 1;
    const finalScore = row.fusedScore * decay * row.confidence * predBoost;
    return { row, score: finalScore };
  });
}

/**
 * Group scored rows by entity and compute the diversity-aware degree
 * boost. Per-entity ranking score is best-fact-score plus a bounded
 * contribution from additional matched facts — only the best fact per
 * (predicate, normalized-3-token-prefix) tuple counts. Prevents an
 * entity with five near-duplicate `complained_about` facts from
 * accumulating a boost five times for one piece of evidence.
 *
 * Pure — no IO. Returns the map for the next stage (edge expansion,
 * PPR, rerank).
 */
export function bucketByEntity(scored: ScoredRow[]): Map<string, EntityBucket> {
  const byEntity = new Map<string, EntityBucket>();
  for (const sf of scored) {
    const eid = String(sf.row.entityId);
    const bucket: EntityBucket =
      byEntity.get(eid) ??
      ({ entityId: eid, rankScore: 0, bestScore: 0, facts: [] } as EntityBucket);
    bucket.facts.push(sf);
    if (sf.score > bucket.bestScore) bucket.bestScore = sf.score;
    byEntity.set(eid, bucket);
  }
  for (const bucket of byEntity.values()) {
    const sortedFacts = [...bucket.facts].sort((a, b) => b.score - a.score);
    const seenKeys = new Set<string>();
    const supplementary: number[] = [];
    for (const f of sortedFacts) {
      const key = diversityKey(f.row.predicate, f.row.object);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (f.score === bucket.bestScore && supplementary.length === 0) continue;
      supplementary.push(f.score);
      if (supplementary.length >= DEGREE_BOOST_TOP_N) break;
    }
    const boost = supplementary.reduce((acc, s) => acc + s, 0);
    bucket.rankScore = bucket.bestScore + DEGREE_BOOST_WEIGHT * boost;
  }
  return byEntity;
}
