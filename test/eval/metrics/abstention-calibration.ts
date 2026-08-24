/**
 * Abstention calibration — Expected Calibration Error (ECE) + an
 * over-reject vs hallucinate split.
 *
 * Two orthogonal safety questions for a memory that can decline to answer:
 *
 *   1. Is the confidence honest? ECE (Guo et al. 2017) bins predictions by
 *      stated confidence and measures the gap between confidence and
 *      empirical correctness in each bin, weighted by bin population. 0 =
 *      perfectly calibrated; a system that says "0.9 confident" and is
 *      right 60% of the time has ECE ≥ 0.3.
 *
 *   2. WHICH way does it fail? The over-reject vs hallucinate split
 *      partitions decisions by ground truth: over-rejecting an answerable
 *      query wastes recall; answering a false-premise query hallucinates.
 *      A single "abstention rate" hides which of the two is happening —
 *      and they have opposite fixes.
 *
 * Both pure.
 */

export interface CalibrationRecord {
  /** Model's stated confidence that it should answer, 0..1. */
  confidence: number;
  /** Whether that decision was correct (the query really was answerable). */
  correct: boolean;
}

/**
 * Expected Calibration Error over `bins` equal-width confidence bins
 * (default 10). Returns null on empty input. Confidence is clamped to
 * [0,1] so a malformed 1.2 doesn't fall off the bin array.
 */
export function expectedCalibrationError(records: CalibrationRecord[], bins = 10): number | null {
  if (records.length === 0) return null;
  const binCount = Math.max(1, Math.floor(bins));
  const confSum = new Array<number>(binCount).fill(0);
  const correctSum = new Array<number>(binCount).fill(0);
  const count = new Array<number>(binCount).fill(0);

  for (const r of records) {
    const c = Math.min(1, Math.max(0, r.confidence));
    // Bin index: [0,1) → 0..binCount-1; exactly 1.0 lands in the last bin.
    const idx = c >= 1 ? binCount - 1 : Math.floor(c * binCount);
    confSum[idx] = (confSum[idx] ?? 0) + c;
    correctSum[idx] = (correctSum[idx] ?? 0) + (r.correct ? 1 : 0);
    count[idx] = (count[idx] ?? 0) + 1;
  }

  const n = records.length;
  let ece = 0;
  for (let i = 0; i < binCount; i++) {
    const ni = count[i] ?? 0;
    if (ni === 0) continue;
    const avgConf = (confSum[i] ?? 0) / ni;
    const accuracy = (correctSum[i] ?? 0) / ni;
    ece += (ni / n) * Math.abs(avgConf - accuracy);
  }
  return ece;
}

export interface AbstentionRecord {
  /** Ground truth: is the query answerable (true) or a false-premise (false)? */
  shouldAnswer: boolean;
  /** The system's decision: did it abstain? */
  abstained: boolean;
}

export interface AbstentionSplit {
  /** Abstained among answerable queries (lost recall). null if none answerable. */
  overRejectRate: number | null;
  /** Answered among false-premise queries (hallucination). null if none. */
  hallucinationRate: number | null;
  /** Correctly answered among answerable. null if none answerable. */
  correctAnswerRate: number | null;
  /** Correctly abstained among false-premise. null if none. */
  correctAbstainRate: number | null;
  answerable: number;
  falsePremise: number;
}

export function abstentionSplit(records: AbstentionRecord[]): AbstentionSplit {
  const answerable = records.filter((r) => r.shouldAnswer);
  const falsePremise = records.filter((r) => !r.shouldAnswer);
  const overRejects = answerable.filter((r) => r.abstained).length;
  const hallucinations = falsePremise.filter((r) => !r.abstained).length;
  return {
    overRejectRate: answerable.length === 0 ? null : overRejects / answerable.length,
    hallucinationRate: falsePremise.length === 0 ? null : hallucinations / falsePremise.length,
    correctAnswerRate:
      answerable.length === 0 ? null : (answerable.length - overRejects) / answerable.length,
    correctAbstainRate:
      falsePremise.length === 0
        ? null
        : (falsePremise.length - hallucinations) / falsePremise.length,
    answerable: answerable.length,
    falsePremise: falsePremise.length,
  };
}
