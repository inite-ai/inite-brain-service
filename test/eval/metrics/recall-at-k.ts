import type { QueryResult } from '../../../src/eval/types';

function isAbsenceQuery(r: QueryResult): boolean {
  return r.piiGatedCorrectly !== null;
}

/**
 * Per-query hit vector for bootstrap CI. Same scoreable filter as
 * recallAtK; emits 1 if the expected entity was in top K, else 0.
 * Empty vector when no scoreable queries.
 */
export function recallAtKVector(results: QueryResult[], k: number): number[] {
  const scoreable = results.filter((r) => !isAbsenceQuery(r));
  return scoreable.map((r) => (r.rankOfExpected > 0 && r.rankOfExpected <= k ? 1 : 0));
}
