/**
 * Cross-lingual Recall@k and nDCG@k.
 *
 * These operate over RANKED CANONICAL REF LISTS (language-neutral), not
 * over the QueryResult shape the monolingual retrieval metrics use — so
 * the same scorer measures a store-ru/query-en case and a store-en/query-en
 * case identically, and the aggregate can be sliced by direction (mono vs
 * cross) to expose the cross-lingual gap the roadmap names.
 *
 * Binary relevance (one gold ref per query), so nDCG degenerates to
 * 1/log2(rank+1) — the same convention as ndcg.ts. Pure functions.
 */

export type RetrievalDirection = 'mono' | 'cross';

export interface RetrievalQuery {
  /** Candidate refs in ranked order (rank 1 = index 0). */
  ranked: string[];
  /** The one canonical ref that should rank top. */
  goldRef: string;
  direction: RetrievalDirection;
}

export interface RetrievalAggregate {
  overall: number | null;
  mono: number | null;
  cross: number | null;
  /** Sample size behind `overall`. */
  n: number;
}

/** 1 when goldRef is within the top k of ranked, else 0. */
export function recallAtKRanked(ranked: string[], goldRef: string, k: number): number {
  return ranked.slice(0, k).includes(goldRef) ? 1 : 0;
}

/** nDCG@k under binary relevance: 1/log2(rank+1) when goldRef ≤ k, else 0. */
export function ndcgAtKRanked(ranked: string[], goldRef: string, k: number): number {
  const idx = ranked.indexOf(goldRef);
  if (idx === -1) return 0;
  const rank = idx + 1;
  if (rank > k) return 0;
  return 1 / Math.log2(rank + 1);
}

function meanOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function aggregate(
  queries: RetrievalQuery[],
  score: (q: RetrievalQuery) => number,
): RetrievalAggregate {
  const all = queries.map(score);
  const mono = queries.filter((q) => q.direction === 'mono').map(score);
  const cross = queries.filter((q) => q.direction === 'cross').map(score);
  return {
    overall: meanOrNull(all),
    mono: meanOrNull(mono),
    cross: meanOrNull(cross),
    n: all.length,
  };
}

export function aggregateRecallAtK(queries: RetrievalQuery[], k: number): RetrievalAggregate {
  return aggregate(queries, (q) => recallAtKRanked(q.ranked, q.goldRef, k));
}

export function aggregateNdcgAtK(queries: RetrievalQuery[], k: number): RetrievalAggregate {
  return aggregate(queries, (q) => ndcgAtKRanked(q.ranked, q.goldRef, k));
}
