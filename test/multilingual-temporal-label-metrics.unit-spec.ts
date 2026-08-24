import {
  temporalExactDayAccuracy,
  temporalAccuracyByLocale,
} from './eval/metrics/temporal-accuracy';
import type { TemporalRecord } from './eval/metrics/temporal-accuracy';
import { labelClassificationMetrics } from './eval/metrics/label-f1';

describe('temporalExactDayAccuracy', () => {
  it('exact day match → 1.0', () => {
    expect(
      temporalExactDayAccuracy([
        { predictedDate: '2026-03-03', goldDate: '2026-03-03', locale: 'en' },
      ]),
    ).toBe(1);
  });

  it('off-by-one day → 0', () => {
    expect(
      temporalExactDayAccuracy([
        { predictedDate: '2026-03-04', goldDate: '2026-03-03', locale: 'de' },
      ]),
    ).toBe(0);
  });

  it('null prediction counts as wrong', () => {
    expect(
      temporalExactDayAccuracy([{ predictedDate: null, goldDate: '2026-03-03', locale: 'zh' }]),
    ).toBe(0);
  });

  it('normalizes a full ISO timestamp to the same day', () => {
    expect(
      temporalExactDayAccuracy([
        { predictedDate: '2026-03-03T09:30:00.000Z', goldDate: '2026-03-03', locale: 'ru' },
      ]),
    ).toBe(1);
  });

  it('unparseable prediction counts as wrong', () => {
    expect(
      temporalExactDayAccuracy([
        { predictedDate: 'not-a-date', goldDate: '2026-03-03', locale: 'ar' },
      ]),
    ).toBe(0);
  });

  it('empty → null', () => {
    expect(temporalExactDayAccuracy([])).toBeNull();
  });

  it('averages a mix', () => {
    const recs: TemporalRecord[] = [
      { predictedDate: '2026-03-03', goldDate: '2026-03-03', locale: 'en' },
      { predictedDate: '2026-03-04', goldDate: '2026-03-03', locale: 'de' },
    ];
    expect(temporalExactDayAccuracy(recs)).toBe(0.5);
  });
});

describe('temporalAccuracyByLocale', () => {
  it('splits per locale, sorted by locale', () => {
    const recs: TemporalRecord[] = [
      { predictedDate: '2026-03-03', goldDate: '2026-03-03', locale: 'zh' },
      { predictedDate: '2026-03-04', goldDate: '2026-03-03', locale: 'en' },
    ];
    const out = temporalAccuracyByLocale(recs);
    expect(out.map((o) => o.locale)).toEqual(['en', 'zh']);
    expect(out.find((o) => o.locale === 'en')!.accuracy).toBe(0);
    expect(out.find((o) => o.locale === 'zh')!.accuracy).toBe(1);
  });
});

describe('labelClassificationMetrics', () => {
  it('perfect labelling → accuracy / micro / macro all 1', () => {
    const r = labelClassificationMetrics([
      { predicted: 'temporal', gold: 'temporal' },
      { predicted: 'default', gold: 'default' },
    ])!;
    expect(r.accuracy).toBe(1);
    expect(r.microF1).toBe(1);
    expect(r.macroF1).toBe(1);
  });

  it('all wrong → zeros', () => {
    const r = labelClassificationMetrics([
      { predicted: 'a', gold: 'b' },
      { predicted: 'b', gold: 'a' },
    ])!;
    expect(r.accuracy).toBe(0);
    expect(r.microF1).toBe(0);
    expect(r.macroF1).toBe(0);
  });

  it('macro punishes a missed rare class harder than micro', () => {
    // gold [A,A,B], predicted [A,A,A]. accuracy = micro = 2/3.
    // A: f1 0.8 (support 2); B: f1 0 (support 1) → macro 0.4.
    const r = labelClassificationMetrics([
      { predicted: 'A', gold: 'A' },
      { predicted: 'A', gold: 'A' },
      { predicted: 'A', gold: 'B' },
    ])!;
    expect(r.accuracy).toBeCloseTo(2 / 3, 6);
    expect(r.microF1).toBeCloseTo(2 / 3, 6);
    expect(r.macroF1).toBeCloseTo(0.4, 6);
    const a = r.perLabel.find((p) => p.label === 'A')!;
    expect(a.f1).toBeCloseTo(0.8, 6);
    expect(a.support).toBe(2);
  });

  it('empty → null', () => {
    expect(labelClassificationMetrics([])).toBeNull();
  });
});
