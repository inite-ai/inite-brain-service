/**
 * Bootstrap gold set for confidence calibration.
 *
 * 200 (rawConfidence, correctness) pairs hand-curated to approximate the
 * empirical miscalibration profile of GPT-4o-mini measured in the
 * Mind-the-Confidence-Gap study (arXiv:2502.11028, 2025):
 *
 *   - Raw confidence ∈ [0.0, 0.4]: extractor is well-calibrated — when
 *     it says "low confidence", it really is wrong about that fraction.
 *   - Raw confidence ∈ [0.4, 0.7]: mild overconfidence — true accuracy
 *     ≈ raw − 0.10.
 *   - Raw confidence ∈ [0.7, 0.9]: moderate overconfidence — true
 *     accuracy ≈ raw − 0.20.
 *   - Raw confidence ∈ [0.9, 1.0]: severe overconfidence — 66.7% of
 *     errors at >0.80 raw. We model this as true accuracy ≈ 0.70 even
 *     when the model emits >= 0.90.
 *
 * Each entry is a discrete (raw, 0|1) sample drawn so the per-bucket
 * mean matches the target accuracy above. The total is split 50/50 by
 * each bucket to give the PAV algorithm enough samples per bin.
 *
 * Replacement plan: a nightly job will replace this with a CHANGEFEED-
 * sourced gold set keyed on retraction outcomes (a fact retracted as
 * 'supersede' within 30d → correctness=0; remained 'active' → 1).
 * Until that runs, this synthetic set is the prior. Configuring
 * `CALIBRATION_USE_GOLD_SET=0` disables the prior and falls back to
 * identity calibration — used for tests + ingest paths where the
 * extractor's raw value already passed an upstream confidence gate.
 */

import type { CalibrationPair } from './isotonic';

function rep(rawConfidence: number, total: number, correctFraction: number): CalibrationPair[] {
  const correctCount = Math.round(total * correctFraction);
  const out: CalibrationPair[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      rawConfidence,
      correctness: i < correctCount ? 1 : 0,
    });
  }
  return out;
}

export const BOOTSTRAP_GOLD_SET: CalibrationPair[] = [
  // Well-calibrated low end
  ...rep(0.05, 20, 0.05), //   1/20  correct
  ...rep(0.15, 20, 0.18), //   ~3/20
  ...rep(0.25, 20, 0.28), //   ~5/20
  ...rep(0.35, 20, 0.38), //   ~7/20
  // Mild overconfidence band
  ...rep(0.45, 20, 0.36), //   ~7/20  (raw - 0.10)
  ...rep(0.55, 20, 0.47), //   ~9/20
  ...rep(0.65, 20, 0.56), //  ~11/20
  // Moderate overconfidence band
  ...rep(0.75, 20, 0.55), //  ~11/20  (raw - 0.20)
  ...rep(0.85, 20, 0.65), //  ~13/20
  // Severe overconfidence — high-emit, modest truth
  ...rep(0.95, 20, 0.7), //  ~14/20
];
