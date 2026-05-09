import type { QueryResult } from '../types';

/**
 * Normalised Discounted Cumulative Gain at rank K.
 *
 * NDCG is the canonical retrieval metric on BEIR / MTEB / MS MARCO —
 * every embedding-model paper since 2020 reports NDCG@10. Adopting
 * it lets our retrieval numbers be directly compared to published
 * baselines instead of living in a recall@k vacuum.
 *
 * Our query expectations are binary-relevance (one expected entity
 * per query), so the formula degenerates to:
 *
 *   DCG@K  = 1 / log2(rank + 1)   if rank ≤ K
 *          = 0                    otherwise
 *   IDCG@K = 1 / log2(2)  = 1     (single relevant doc, ideal rank=1)
 *   NDCG@K = DCG@K / IDCG@K       = 1/log2(rank+1) when rank ≤ K
 *
 * Aggregate is the mean across queries. A query that missed entirely
 * (rankOfExpected=0) contributes 0 to the numerator. Returns null
 * on empty input so the aggregator surfaces "—" rather than 0.
 */
export function ndcgAtK(results: QueryResult[], k: number): number | null {
  if (results.length === 0) return null;
  let sum = 0;
  for (const r of results) {
    if (r.rankOfExpected > 0 && r.rankOfExpected <= k) {
      sum += 1 / Math.log2(r.rankOfExpected + 1);
    }
  }
  return sum / results.length;
}
