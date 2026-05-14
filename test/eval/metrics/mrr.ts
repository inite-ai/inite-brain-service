import type { QueryResult } from '../types';

/**
 * Mean Reciprocal Rank. For each query: 1/rank if expected found,
 * 0 otherwise. Average over all scoreable queries (excludes
 * absence-style PII-gating queries).
 *
 * Returns null on empty partition — see recall-at-k.ts for rationale.
 * The temporal/current split surfaces empty MRR partitions wherever a
 * vertical has no asOf queries; rendering those as "0" reads as a
 * regression rather than "no data".
 */
export function meanReciprocalRank(results: QueryResult[]): number | null {
  const scoreable = results.filter((r) => r.piiGatedCorrectly === null);
  if (scoreable.length === 0) return null;
  const sum = scoreable.reduce((acc, r) => acc + (r.rankOfExpected > 0 ? 1 / r.rankOfExpected : 0), 0);
  return sum / scoreable.length;
}

/**
 * Per-query reciprocal-rank vector for bootstrap CI.
 */
export function reciprocalRankVector(results: QueryResult[]): number[] {
  const scoreable = results.filter((r) => r.piiGatedCorrectly === null);
  return scoreable.map((r) =>
    r.rankOfExpected > 0 ? 1 / r.rankOfExpected : 0,
  );
}
