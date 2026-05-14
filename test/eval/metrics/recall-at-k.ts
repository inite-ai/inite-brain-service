import type { QueryResult } from '../types';

/**
 * Recall@K — share of queries where the expected entity appears in top K
 * of the returned results.
 *
 * Skips queries with `mustBeAbsent` semantics (those are scored by the
 * pii-gating metric instead).
 *
 * Returns null when the input partition is empty — e.g. recall@1:temporal
 * for a vertical with no asOf queries. Reporting 0.0 on an empty
 * partition is misleading: it's indistinguishable from "every temporal
 * query missed", which is exactly the regression mode the temporal split
 * was added to surface.
 */
export function recallAtK(results: QueryResult[], k: number): number | null {
  const scoreable = results.filter((r) => !isAbsenceQuery(r));
  if (scoreable.length === 0) return null;
  const hits = scoreable.filter((r) => r.rankOfExpected > 0 && r.rankOfExpected <= k).length;
  return hits / scoreable.length;
}

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
  return scoreable.map((r) =>
    r.rankOfExpected > 0 && r.rankOfExpected <= k ? 1 : 0,
  );
}
