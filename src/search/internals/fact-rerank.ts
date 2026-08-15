import type { EntityBucket, ScoredRow } from './types';

/**
 * Fact-level cross-encoder rescoring (July program A3,
 * docs/roadmap/locomo-sota-architecture-2026-07.md §6.3) — pure
 * helpers; the CE call itself lives in SearchRerankService.
 *
 * The entity-bucket cross-encoder pass reorders BUCKETS, but the
 * fact-centric budget cut (selectFactCentric) slices the flat fact
 * pool purely by fused score — a near-duplicate with better lexical
 * luck outranks the gold fact and the budget window fills with it
 * (the measured dominant miss class: 117/176 dev-5 misses hold the
 * gold IN the derived facts, v11-session-2026-08.md §8). These
 * helpers let a joint encoder reorder the top-`window` facts of that
 * pool before the cut.
 *
 * Score remap contract: the SET of score values inside the window is
 * preserved exactly — row at cross-encoder rank k receives the k-th
 * highest ORIGINAL window score. Consequences, all deliberate:
 *   - the window/tail boundary cannot move (min window score is
 *     unchanged), so facts outside the window are unaffected;
 *   - the top-1 score VALUE is unchanged, so downstream consumers of
 *     the maximum (abstention's minTopScore gate) see the same number;
 *   - an identity permutation is a byte-identical no-op.
 */

export interface WindowedFact {
  bucket: EntityBucket;
  row: ScoredRow;
}

/**
 * Flatten every scored row across the buckets and keep the top
 * `window` by fused score, descending — the slice a cross-encoder
 * pass can afford to rescore.
 */
export function collectFactWindow(
  buckets: EntityBucket[],
  window: number,
): WindowedFact[] {
  const flat: WindowedFact[] = [];
  for (const bucket of buckets) {
    for (const row of bucket.facts) flat.push({ bucket, row });
  }
  flat.sort((a, b) => b.row.score - a.row.score);
  return flat.slice(0, Math.max(0, window));
}

/**
 * Apply a cross-encoder permutation to the window IN PLACE via the
 * rank-preserving score remap described above. `permutation[k]` is the
 * window index of the k-th most relevant fact per the cross-encoder
 * (the CrossEncoderService.rerank contract). A malformed permutation
 * (wrong length, out-of-range or duplicate indices) is ignored — the
 * fused order stands, mirroring the identity-fallback contract of the
 * CE service itself.
 */
export function remapWindowScores(
  rows: WindowedFact[],
  permutation: number[],
): boolean {
  const n = rows.length;
  if (permutation.length !== n) return false;
  const seen = new Set<number>();
  for (const i of permutation) {
    if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) return false;
    seen.add(i);
  }
  // rows arrive sorted desc by fused score (collectFactWindow), so
  // rows[k].row.score IS the k-th highest original value.
  const ranked = rows.map((r) => r.row.score);
  for (let k = 0; k < n; k++) {
    rows[permutation[k]].row.score = ranked[k];
  }
  return true;
}
