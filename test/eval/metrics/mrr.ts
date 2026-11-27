import type { QueryResult } from '../../../src/eval/types';

/**
 * Per-query reciprocal-rank vector for bootstrap CI.
 */
export function reciprocalRankVector(results: QueryResult[]): number[] {
  const scoreable = results.filter((r) => r.piiGatedCorrectly === null);
  return scoreable.map((r) => (r.rankOfExpected > 0 ? 1 / r.rankOfExpected : 0));
}
