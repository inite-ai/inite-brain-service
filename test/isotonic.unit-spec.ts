import {
  applyMap,
  fitIsotonic,
  type CalibrationPair,
} from '../src/ai/calibration/isotonic';
import { BOOTSTRAP_GOLD_SET } from '../src/ai/calibration/gold-set';

describe('fitIsotonic + applyMap', () => {
  it('returns identity map for empty input', () => {
    const m = fitIsotonic([]);
    expect(m.sampleCount).toBe(0);
    expect(applyMap(m, 0.5)).toBe(1); // single bucket → 1.0
  });

  it('produces a non-decreasing values sequence (monotone)', () => {
    const m = fitIsotonic(BOOTSTRAP_GOLD_SET);
    for (let i = 1; i < m.values.length; i++) {
      expect(m.values[i]).toBeGreaterThanOrEqual(m.values[i - 1]!);
    }
  });

  it('rightmost threshold is exactly 1', () => {
    const m = fitIsotonic(BOOTSTRAP_GOLD_SET);
    expect(m.thresholds[m.thresholds.length - 1]).toBe(1);
  });

  it('on the bootstrap gold set, lowers high raw confidence', () => {
    // 66.7% of errors at >0.80 raw in the published study — the
    // bootstrap encodes that, so applyMap(0.95) must be << 0.95.
    const m = fitIsotonic(BOOTSTRAP_GOLD_SET);
    const calibrated = applyMap(m, 0.95);
    expect(calibrated).toBeLessThan(0.85);
  });

  it('on the bootstrap gold set, leaves low confidence near identity', () => {
    const m = fitIsotonic(BOOTSTRAP_GOLD_SET);
    const calibrated = applyMap(m, 0.05);
    // Should be small — near the bottom of the rest spaced grid.
    expect(calibrated).toBeLessThan(0.2);
  });

  it('pools adjacent violators (mean[k] > mean[k+1] gets merged)', () => {
    const pairs: CalibrationPair[] = [
      // Bin 0: 100% correct — must monotone-pool with bin 1 (60%)
      ...Array.from({ length: 5 }, () => ({
        rawConfidence: 0.05,
        correctness: 1 as const,
      })),
      // Bin 1: 60%
      ...Array.from({ length: 5 }, (_, i) => ({
        rawConfidence: 0.15,
        correctness: (i < 3 ? 1 : 0) as 0 | 1,
      })),
      // Bin 2: 80%
      ...Array.from({ length: 5 }, (_, i) => ({
        rawConfidence: 0.25,
        correctness: (i < 4 ? 1 : 0) as 0 | 1,
      })),
    ];
    const m = fitIsotonic(pairs, 10);
    expect(m.values.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < m.values.length; i++) {
      expect(m.values[i]).toBeGreaterThanOrEqual(m.values[i - 1]!);
    }
  });

  it('clamps inputs outside [0, 1] before lookup', () => {
    const m = fitIsotonic(BOOTSTRAP_GOLD_SET);
    expect(applyMap(m, -0.5)).toBe(applyMap(m, 0));
    expect(applyMap(m, 1.5)).toBe(applyMap(m, 1));
    expect(applyMap(m, NaN)).toBe(applyMap(m, 0));
  });
});
