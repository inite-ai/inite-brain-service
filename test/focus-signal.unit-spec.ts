/**
 * Unit spec — fovea focus signal (Optics-1 pure module).
 *
 * Covers the raw signal (monotonicity + bounds), class mapping, signal
 * construction from fact scores, per-class isotonic fit + sparse-class
 * fallback, calibrated confidence, and the §3 reliability/ECE measurement
 * (perfectly-calibrated → ECE≈0, miscalibrated → ECE>0, per-class split).
 */
import { applyMap } from '../src/ai/calibration/isotonic';
import {
  buildFocusSignal,
  calibratedConfidence,
  computeReliability,
  DEFAULT_CLASS,
  fitPerClass,
  MIN_CLASS_SAMPLES,
  queryClassOf,
  rawFocusConfidence,
  type FocusOutcomeSample,
  type FocusSignal,
  type FocusVerdict,
} from '../src/synthesize/focus-signal';

/** Construct a signal whose rawFocusConfidence is exactly `p` (used to
 *  drive the reliability tests to known bins). raw = 0.65·x + 0.35·v with
 *  x = coverage = gap = top and v ∈ {0,1}; solve for x per target. */
function signalWithRaw(p: number, queryClass = DEFAULT_CLASS): FocusSignal {
  const useSupported = p > 0.65;
  const v = useSupported ? 1 : 0;
  const x = Math.min(1, Math.max(0, (p - 0.35 * v) / 0.65));
  return {
    queryClass,
    topScore: x,
    coverageScore: x,
    retrievalGap: x,
    verifierVerdict: useSupported ? 'supported' : 'none',
  };
}

describe('rawFocusConfidence', () => {
  const base: FocusSignal = {
    queryClass: 'temporal',
    topScore: 0.4,
    coverageScore: 0.4,
    retrievalGap: 0.4,
    verifierVerdict: 'partial',
  };

  it('stays within [0,1] at the extremes and clamps out-of-range inputs', () => {
    expect(
      rawFocusConfidence({
        queryClass: 'x',
        topScore: 0,
        coverageScore: 0,
        retrievalGap: 0,
        verifierVerdict: 'none',
      }),
    ).toBe(0);
    expect(
      rawFocusConfidence({
        queryClass: 'x',
        topScore: 1,
        coverageScore: 1,
        retrievalGap: 1,
        verifierVerdict: 'supported',
      }),
    ).toBe(1);
    // Out-of-range inputs are clamped, never overflow.
    const over = rawFocusConfidence({
      queryClass: 'x',
      topScore: 5,
      coverageScore: 9,
      retrievalGap: -3,
      verifierVerdict: 'supported',
    });
    expect(over).toBeGreaterThanOrEqual(0);
    expect(over).toBeLessThanOrEqual(1);
  });

  it('is monotone-nondecreasing in each continuous input', () => {
    const up = (patch: Partial<FocusSignal>) => rawFocusConfidence({ ...base, ...patch });
    expect(up({ coverageScore: 0.9 })).toBeGreaterThan(rawFocusConfidence(base));
    expect(up({ topScore: 0.9 })).toBeGreaterThan(rawFocusConfidence(base));
    expect(up({ retrievalGap: 0.9 })).toBeGreaterThan(rawFocusConfidence(base));
  });

  it('orders the verdict contribution supported > partial > unsupported = none', () => {
    const withVerdict = (verifierVerdict: FocusVerdict) =>
      rawFocusConfidence({ ...base, verifierVerdict });
    expect(withVerdict('supported')).toBeGreaterThan(withVerdict('partial'));
    expect(withVerdict('partial')).toBeGreaterThan(withVerdict('unsupported'));
    expect(withVerdict('unsupported')).toBe(withVerdict('none'));
  });
});

describe('queryClassOf', () => {
  it('maps a LaneId to itself and null/undefined to the default class', () => {
    expect(queryClassOf('temporal')).toBe('temporal');
    expect(queryClassOf('enumeration')).toBe('enumeration');
    expect(queryClassOf(null)).toBe(DEFAULT_CLASS);
    expect(queryClassOf(undefined)).toBe(DEFAULT_CLASS);
  });
});

describe('buildFocusSignal', () => {
  it('computes topScore, mean coverage, and top1−topN gap from fact scores', () => {
    const sig = buildFocusSignal({
      queryClass: 'temporal',
      factScores: [0.5, 0.9, 0.1],
      verifierVerdict: 'supported',
    });
    expect(sig.topScore).toBeCloseTo(0.9, 10);
    expect(sig.coverageScore).toBeCloseTo((0.5 + 0.9 + 0.1) / 3, 10);
    expect(sig.retrievalGap).toBeCloseTo(0.9 - 0.1, 10);
    expect(sig.queryClass).toBe('temporal');
    expect(sig.verifierVerdict).toBe('supported');
  });

  it('returns an all-zero signal for empty evidence', () => {
    const sig = buildFocusSignal({ queryClass: 'x', factScores: [], verifierVerdict: 'none' });
    expect(sig.topScore).toBe(0);
    expect(sig.coverageScore).toBe(0);
    expect(sig.retrievalGap).toBe(0);
  });

  it('clamps out-of-range and drops non-finite scores', () => {
    const sig = buildFocusSignal({
      queryClass: 'x',
      factScores: [2, -1, Number.NaN, 0.5],
      verifierVerdict: 'partial',
    });
    // 2→1, -1→0, NaN dropped, 0.5 kept.
    expect(sig.topScore).toBe(1);
    expect(sig.coverageScore).toBeCloseTo((1 + 0 + 0.5) / 3, 10);
    expect(sig.retrievalGap).toBe(1);
  });
});

describe('fitPerClass + calibratedConfidence', () => {
  function samplesFor(queryClass: string, n: number): FocusOutcomeSample[] {
    // Monotone-ish: correct becomes likely as raw rises.
    const out: FocusOutcomeSample[] = [];
    for (let i = 0; i < n; i++) {
      const p = (i + 0.5) / n;
      const sig = signalWithRaw(p, queryClass);
      out.push({ ...sig, correct: p > 0.5 ? 1 : 0 });
    }
    return out;
  }

  it('fits an own map for populated classes and falls back to default for sparse ones', () => {
    const samples = [
      ...samplesFor('temporal', MIN_CLASS_SAMPLES + 10),
      ...samplesFor('preference', 5), // below MIN → no own map
    ];
    const cal = fitPerClass(samples);
    expect(cal[DEFAULT_CLASS]).toBeDefined();
    expect(cal['temporal']).toBeDefined();
    expect(cal['preference']).toBeUndefined();
    // The default map is fit over EVERY sample.
    expect(cal[DEFAULT_CLASS]!.sampleCount).toBe(samples.length);
    expect(cal['temporal']!.sampleCount).toBe(MIN_CLASS_SAMPLES + 10);
  });

  it('calibratedConfidence uses the class map, falls back to default, else identity', () => {
    const samples = samplesFor('temporal', MIN_CLASS_SAMPLES + 10);
    const cal = fitPerClass(samples);

    const temporalSig = signalWithRaw(0.8, 'temporal');
    expect(calibratedConfidence(cal, temporalSig)).toBeCloseTo(
      applyMap(cal['temporal']!, rawFocusConfidence(temporalSig)),
      10,
    );

    // Unknown class → default map.
    const unknownSig = signalWithRaw(0.8, 'summary');
    expect(calibratedConfidence(cal, unknownSig)).toBeCloseTo(
      applyMap(cal[DEFAULT_CLASS]!, rawFocusConfidence(unknownSig)),
      10,
    );

    // Empty calibration → identity (raw passthrough).
    expect(calibratedConfidence({}, unknownSig)).toBeCloseTo(rawFocusConfidence(unknownSig), 10);

    // Output stays in [0,1].
    const c = calibratedConfidence(cal, temporalSig);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe('computeReliability (§3 ECE + diagram)', () => {
  /** A perfectly-calibrated set: at each bin center, empirical == predicted. */
  function perfectlyCalibrated(queryClass: string, perBin = 100, bins = 10): FocusOutcomeSample[] {
    const out: FocusOutcomeSample[] = [];
    for (let b = 0; b < bins; b++) {
      const center = (b + 0.5) / bins;
      const correctCount = Math.round(center * perBin);
      for (let i = 0; i < perBin; i++) {
        out.push({ ...signalWithRaw(center, queryClass), correct: i < correctCount ? 1 : 0 });
      }
    }
    return out;
  }

  it('reports ECE ≈ 0 for a perfectly-calibrated set', () => {
    const report = computeReliability(perfectlyCalibrated(DEFAULT_CLASS), 10);
    expect(report.ece).toBeLessThan(0.01);
    expect(report.diagram).toHaveLength(10);
    // Bin edges tile [0,1] with no gaps.
    expect(report.diagram[0]!.binLo).toBe(0);
    expect(report.diagram[9]!.binHi).toBeCloseTo(1, 10);
    // Populated bins carry counts.
    expect(report.diagram.every((d) => d.count > 0)).toBe(true);
  });

  it('reports ECE > 0 for a miscalibrated (overconfident) set', () => {
    // High predicted (~0.9) but always wrong → large calibration gap.
    const bad: FocusOutcomeSample[] = Array.from({ length: 100 }, () => ({
      ...signalWithRaw(0.9, DEFAULT_CLASS),
      correct: 0 as const,
    }));
    const report = computeReliability(bad, 10);
    expect(report.ece).toBeGreaterThan(0.5);
  });

  it('splits ECE per query-class', () => {
    const samples = [
      ...perfectlyCalibrated('good'),
      ...Array.from({ length: 100 }, () => ({
        ...signalWithRaw(0.9, 'bad'),
        correct: 0 as const,
      })),
    ];
    const report = computeReliability(samples, 10);
    expect(report.perClassEce['good']).toBeLessThan(0.01);
    expect(report.perClassEce['bad']).toBeGreaterThan(0.5);
  });

  it('is empty-input safe (ECE 0, all bins zero-count)', () => {
    const report = computeReliability([], 10);
    expect(report.ece).toBe(0);
    expect(report.diagram).toHaveLength(10);
    expect(report.diagram.every((d) => d.count === 0)).toBe(true);
    expect(report.perClassEce).toEqual({});
  });
});
