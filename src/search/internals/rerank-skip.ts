/**
 * Decide whether the LLM reranker can be skipped based on the
 * fused-score margin between the current top-1 and top-2 entities.
 *
 * Relative margin: `(top1 − top2) / top1 ≥ marginThreshold`. We use
 * the relative form because `rankScore` is post-degree-boost and not
 * normalised to [0, 1] — an absolute threshold would behave wildly
 * differently across queries with sparse vs dense candidate sets.
 *
 * Returns false when:
 *   - threshold ≤ 0 (feature disabled)
 *   - candidate set ≤ 1 (no rerank target anyway)
 *   - top1 score is non-positive (degenerate / empty result)
 *   - the gap is below threshold (LLM call still earns its keep)
 */
export function shouldSkipRerankByMargin(
  candidates: Array<{ rankScore: number }>,
  marginThreshold: number,
): boolean {
  if (marginThreshold <= 0) return false;
  if (candidates.length < 2) return false;
  const top = candidates[0].rankScore;
  if (top <= 0) return false;
  const gap = (top - candidates[1].rankScore) / top;
  return gap >= marginThreshold;
}
