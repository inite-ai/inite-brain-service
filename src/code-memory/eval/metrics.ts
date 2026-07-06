/**
 * Code-memory Phase 3 — evaluation metrics (docs/roadmap/code-memory-domain.md).
 *
 * Pure set-based metrics over {expected, retrieved} id sets. Used by the
 * code-memory eval to score two things the domain must guarantee:
 *   - recall — does the stored "why" come back for a query (exact anchor read
 *     AND semantic search)?
 *   - invariant surfacing — when an agent touches an anchor, is the invariant it
 *     must not violate handed to it? This is the actionable design-constraint-
 *     compliance PRECONDITION code-memory can provide. (Full agent-in-the-loop
 *     compliance à la SWE-Shield needs an agent harness — out of scope here.)
 */

/** |expected ∩ retrieved| / |expected|. Vacuously 1 when nothing is expected. */
export function recall(expected: string[], retrieved: string[]): number {
  if (expected.length === 0) return 1;
  const got = new Set(retrieved);
  const hit = expected.filter((e) => got.has(e)).length;
  return hit / expected.length;
}

/** |expected ∩ retrieved| / |retrieved|. Vacuously 1 when nothing retrieved. */
export function precision(expected: string[], retrieved: string[]): number {
  if (retrieved.length === 0) return 1;
  const want = new Set(expected);
  const hit = retrieved.filter((r) => want.has(r)).length;
  return hit / retrieved.length;
}

/** Recall considering only the top-k of a ranked retrieval. */
export function recallAtK(
  expected: string[],
  rankedRetrieved: string[],
  k: number,
): number {
  return recall(expected, rankedRetrieved.slice(0, k));
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface EvalCase {
  expected: string[];
  retrieved: string[];
}

export interface EvalSummary {
  cases: number;
  meanRecall: number;
  meanPrecision: number;
}

export function summarize(cases: EvalCase[]): EvalSummary {
  return {
    cases: cases.length,
    meanRecall: mean(cases.map((c) => recall(c.expected, c.retrieved))),
    meanPrecision: mean(cases.map((c) => precision(c.expected, c.retrieved))),
  };
}
