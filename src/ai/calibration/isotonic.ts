/**
 * Isotonic regression via the Pool-Adjacent-Violators (PAV) algorithm.
 *
 * Used by the Phase 3 confidence-calibration layer to learn a
 * monotone map `rawConfidence → calibratedConfidence` from a gold set
 * of (raw, observed-correctness) pairs. PAV is the right primitive
 * for this — it gives the maximum-likelihood non-parametric
 * monotone fit, with no functional-form assumption.
 *
 * Why isotonic and not Platt scaling: Platt assumes a sigmoid, which
 * is wrong for LLM-emitted confidence (well-documented overconfidence
 * tail). Isotonic captures arbitrary monotone miscalibration, which
 * matches the empirical shape (GPT-4o-mini 2025 study: 66.7% of
 * errors at >80% raw confidence).
 *
 * Pure module — no DI, no IO. Service code in calibration.service.ts
 * fits the map at boot / nightly and consumes it via `applyMap()`.
 */

export interface CalibrationPair {
  /** Raw confidence emitted by the extractor LLM, in [0, 1]. */
  rawConfidence: number;
  /** Observed correctness — 1 if the fact was correct, 0 otherwise. */
  correctness: 0 | 1;
}

/**
 * Piecewise-constant monotone map keyed by raw-confidence thresholds.
 * `thresholds[i]` is the upper bound of bin `i`; `values[i]` is the
 * calibrated value emitted when raw <= thresholds[i].
 * Always: thresholds.length === values.length; thresholds[last] === 1.
 */
export interface CalibrationMap {
  thresholds: number[];
  values: number[];
  /** Number of training pairs that produced this map — diagnostic. */
  sampleCount: number;
}

/**
 * Fit a monotone calibration map from raw → observed via Pool-Adjacent-
 * Violators. Bins the input on a fixed grid so the resulting map is
 * compact (≤ 20 thresholds) and serialisable into a SurrealDB row.
 *
 * Algorithm:
 *   1. Sort pairs by rawConfidence.
 *   2. Group into `binCount` equal-width bins on [0, 1].
 *   3. Compute mean(correctness) per non-empty bin.
 *   4. Pool adjacent violators until the sequence is non-decreasing.
 *   5. Emit (thresholds, values) corresponding to the final pooled bins.
 *
 * Edge cases:
 *   - empty input → identity map (a single bucket [0, 1] → 1).
 *   - all-same-correctness input → constant map at that value.
 */
export function fitIsotonic(
  pairs: readonly CalibrationPair[],
  binCount = 10,
): CalibrationMap {
  if (pairs.length === 0) {
    return { thresholds: [1], values: [1], sampleCount: 0 };
  }

  const sorted = [...pairs].sort((a, b) => a.rawConfidence - b.rawConfidence);

  // 1. Bin into [0, 1] with binCount equal-width bins.
  const binSums: number[] = new Array(binCount).fill(0);
  const binCounts: number[] = new Array(binCount).fill(0);
  const binUpperBounds: number[] = [];
  for (let i = 1; i <= binCount; i++) binUpperBounds.push(i / binCount);

  for (const p of sorted) {
    const c = clamp01(p.rawConfidence);
    let idx = Math.floor(c * binCount);
    if (idx >= binCount) idx = binCount - 1;
    binSums[idx] += p.correctness;
    binCounts[idx] += 1;
  }

  // 2. Compute means for non-empty bins. Empty bins are skipped entirely
  // (not interpolated) — only populated bins enter the PAV pass below, and
  // the piecewise-constant map fills the gaps at predict() time by reading
  // the bin whose upper bound covers the query confidence.
  const populated: Array<{ upper: number; mean: number; weight: number }> = [];
  for (let i = 0; i < binCount; i++) {
    if (binCounts[i] === 0) continue;
    populated.push({
      upper: binUpperBounds[i],
      mean: binSums[i] / binCounts[i],
      weight: binCounts[i],
    });
  }

  // 3. PAV: collapse adjacent violators (mean[k] > mean[k+1]) by
  // weighted-merging until non-decreasing.
  for (let i = 0; i < populated.length - 1; ) {
    if (populated[i].mean <= populated[i + 1].mean) {
      i++;
      continue;
    }
    // Merge i and i+1.
    const w1 = populated[i].weight;
    const w2 = populated[i + 1].weight;
    const mergedMean =
      (populated[i].mean * w1 + populated[i + 1].mean * w2) / (w1 + w2);
    populated[i] = {
      upper: populated[i + 1].upper,
      mean: mergedMean,
      weight: w1 + w2,
    };
    populated.splice(i + 1, 1);
    if (i > 0) i--; // re-check the now-merged left neighbour
  }

  if (populated.length === 0) {
    return { thresholds: [1], values: [1], sampleCount: pairs.length };
  }

  // 4. Force the rightmost threshold to 1.0 so any raw confidence is
  // matched, even if the highest training bin happened to be < 1.0.
  populated[populated.length - 1].upper = 1;

  return {
    thresholds: populated.map((p) => p.upper),
    values: populated.map((p) => p.mean),
    sampleCount: pairs.length,
  };
}

/**
 * Apply a fitted calibration map to a raw confidence. Falls through to
 * the identity if the map is the bootstrap (single-bucket → 1) and the
 * input is in range.
 */
export function applyMap(map: CalibrationMap, rawConfidence: number): number {
  const c = clamp01(rawConfidence);
  for (let i = 0; i < map.thresholds.length; i++) {
    if (c <= map.thresholds[i]) return clamp01(map.values[i]);
  }
  return clamp01(map.values[map.values.length - 1]);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
