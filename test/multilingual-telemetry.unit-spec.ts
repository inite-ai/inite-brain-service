import { aggregateLanguageAttribution } from './eval/metrics/language-attribution';
import type { LanguageAttributionSample } from '../src/eval/types';

const s = (
  lang: string,
  source: LanguageAttributionSample['source'],
  confidence: number,
  detectorVersion = 'v1',
): LanguageAttributionSample => ({ lang, source, confidence, detectorVersion });

describe('aggregateLanguageAttribution', () => {
  it('empty → total 0, empty distributions, null means', () => {
    const r = aggregateLanguageAttribution([]);
    expect(r.total).toBe(0);
    expect(r.byLanguage).toEqual([]);
    expect(r.bySource).toEqual([]);
    expect(r.byDetectorVersion).toEqual([]);
    expect(r.meanConfidence).toBeNull();
    expect(r.lowConfidenceRate).toBeNull();
  });

  it('rolls up per-language count + mean confidence, most frequent first', () => {
    const r = aggregateLanguageAttribution([
      s('ru', 'fact', 0.9),
      s('ru', 'query', 0.7),
      s('en', 'query', 0.8),
    ]);
    expect(r.total).toBe(3);
    expect(r.byLanguage[0]!.lang).toBe('ru');
    expect(r.byLanguage[0]!.count).toBe(2);
    expect(r.byLanguage[0]!.meanConfidence).toBeCloseTo(0.8, 6);
    expect(r.byLanguage[1]!.lang).toBe('en');
  });

  it('counts per source and per detector version', () => {
    const r = aggregateLanguageAttribution([
      s('ru', 'fact', 0.9, 'v1'),
      s('en', 'query', 0.8, 'v1'),
      s('en', 'query', 0.6, 'v2'),
    ]);
    expect(r.bySource.find((x) => x.source === 'query')!.count).toBe(2);
    expect(r.bySource.find((x) => x.source === 'fact')!.count).toBe(1);
    expect(r.byDetectorVersion.find((x) => x.detectorVersion === 'v1')!.count).toBe(2);
    expect(r.byDetectorVersion.find((x) => x.detectorVersion === 'v2')!.count).toBe(1);
  });

  it('overall mean confidence + low-confidence rate at the default threshold', () => {
    // confidences 0.9, 0.5, 0.6 → mean 0.6667; below-0.7: two of three.
    const r = aggregateLanguageAttribution([
      s('ru', 'fact', 0.9),
      s('en', 'query', 0.5),
      s('zh', 'fact', 0.6),
    ]);
    expect(r.meanConfidence).toBeCloseTo(2 / 3, 6);
    expect(r.lowConfidenceRate).toBeCloseTo(2 / 3, 6);
    expect(r.lowConfidenceThreshold).toBe(0.7);
  });

  it('honours a custom low-confidence threshold', () => {
    const r = aggregateLanguageAttribution([s('ru', 'fact', 0.9), s('en', 'query', 0.5)], 0.55);
    expect(r.lowConfidenceRate).toBe(0.5); // only 0.5 is below 0.55
    expect(r.lowConfidenceThreshold).toBe(0.55);
  });
});
