import type { IdentityMergeResult } from '../../../src/eval/types';

/**
 * Identity-resolution metrics — pairwise precision / recall / F1 over
 * declared identity_of intents.
 *
 * The previous metric was a single rate(merged) — completely blind to
 * FALSE merges (brain over-eagerly unifying two distinct entities).
 * That made it a placebo: an over-merging implementation could score
 * 1.0 while silently corrupting tenant data.
 *
 * Pairwise definition:
 *   - true positive  : a declared (survivor, loser) pair was merged.
 *   - false negative : a declared pair was NOT merged.
 *   - false positive : a declared distractor (shouldNotMerge ref) was
 *                      merged into the survivor anyway.
 *
 * recall    = TP / (TP + FN)
 * precision = TP / (TP + FP)
 * F1        = 2 · P · R / (P + R)
 *
 * All three are null when no scenarios declared identityMerge — a
 * pure-retrieval slice should not punch a hole in the dashboard.
 */

export interface IdentityResolutionMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  /**
   * Distractor refs that the harness could not resolve at all. NOT
   * counted in precision (we can't know whether they would have
   * over-merged) but surfaced so a misconfigured scenario shows up.
   */
  unresolvedDistractors: number;
}

export function identityResolutionMetrics(
  results: IdentityMergeResult[],
): IdentityResolutionMetrics {
  if (results.length === 0) {
    return {
      precision: null,
      recall: null,
      f1: null,
      truePositives: 0,
      falseNegatives: 0,
      falsePositives: 0,
      unresolvedDistractors: 0,
    };
  }

  let tp = 0;
  let fn = 0;
  let fp = 0;
  let unresolved = 0;
  for (const r of results) {
    if (r.merged) tp++;
    else fn++;
    fp += r.falseMerges.length;
    unresolved += r.unresolvedDistractors.length;
  }

  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const f1 =
    recall === null || precision === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return {
    precision,
    recall,
    f1,
    truePositives: tp,
    falseNegatives: fn,
    falsePositives: fp,
    unresolvedDistractors: unresolved,
  };
}

/**
 * Backwards-compat shim — preserves the old `identity-resolution` rate
 * for callers that haven't migrated yet. Equivalent to the old metric:
 * share of declared merges that succeeded, blind to false merges.
 */
export function identityResolutionRate(results: IdentityMergeResult[]): number | null {
  if (results.length === 0) return null;
  const ok = results.filter((r) => r.merged).length;
  return ok / results.length;
}
