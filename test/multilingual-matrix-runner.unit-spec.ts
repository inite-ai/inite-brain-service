import { multilingualMatrix } from '../src/eval/scenarios';
import type { MultilingualMetricCell } from '../src/eval/types';
import {
  StubModel,
  RealModel,
  createMultilingualModel,
  isLiveEvalEnabled,
} from './eval/multilingual/model';
import { MultilingualMatrixRunner } from './eval/multilingual/matrix-runner';
import { MultilingualReporter } from './eval/multilingual/matrix-reporter';

const runner = new MultilingualMatrixRunner();

const cellOf = (cells: MultilingualMetricCell[], name: string): MultilingualMetricCell => {
  const c = cells.find((x) => x.metric === name);
  if (!c) throw new Error(`metric ${name} not found`);
  return c;
};

describe('multilingualMatrix (data fixture)', () => {
  it('is non-empty and every case declares at least one gold dimension', () => {
    expect(multilingualMatrix.length).toBeGreaterThan(0);
    for (const c of multilingualMatrix) {
      expect(Object.keys(c.gold).length).toBeGreaterThan(0);
      expect(
        c.direction === 'mono' ? c.storeLang === c.queryLang : c.storeLang !== c.queryLang,
      ).toBe(true);
    }
  });

  it('covers all five failure modes and the seven languages', () => {
    const modes = new Set(multilingualMatrix.map((c) => c.failureMode));
    expect(modes).toEqual(
      new Set([
        'cross_lingual_retrieval',
        'short_string_mislabel',
        'entity_fragmentation',
        'temporal_locale',
        'code_switching',
      ]),
    );
    const langs = new Set(multilingualMatrix.flatMap((c) => [c.storeLang, c.queryLang]));
    for (const l of ['en', 'ru', 'de', 'es', 'zh', 'ar', 'hi'])
      expect(langs.has(l as never)).toBe(true);
  });
});

describe('MultilingualMatrixRunner — StubModel end-to-end (no model calls)', () => {
  it('perfect stub → scenarios wire through to a near-ideal report', () => {
    const model = new StubModel({ mode: 'perfect' });
    expect(model.kind).toBe('stub');
    const report = runner.run(multilingualMatrix, model);

    expect(report.modelKind).toBe('stub');
    expect(report.slices.length).toBeGreaterThan(0);
    // Every slice carries the full, identically-ordered metric column set.
    const width = report.overall.length;
    for (const s of report.slices) expect(s.metrics.length).toBe(width);

    expect(cellOf(report.overall, 'recall@1').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'recall@1').value!).toBeGreaterThanOrEqual(
      cellOf(report.overall, 'recall@1').threshold!,
    );
    expect(cellOf(report.overall, 'extraction-f1').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'entity-linking-accuracy').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'fragmentation-rate').value).toBe(0);
    expect(cellOf(report.overall, 'temporal-exact-day').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'conflict-label-f1').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'lane-label-f1').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'answer-language-correctness').value).toBeCloseTo(1, 6);
    expect(cellOf(report.overall, 'over-reject-rate').value).toBe(0);
    expect(cellOf(report.overall, 'hallucination-rate').value).toBe(0);
    expect(cellOf(report.overall, 'abstention-ece').value!).toBeLessThan(0.15);

    expect(report.telemetry.total).toBeGreaterThan(0);
    expect(report.telemetry.byLanguage.length).toBeGreaterThan(0);
  });

  it('degraded stub → the same wiring shows the metrics drop', () => {
    const report = runner.run(multilingualMatrix, new StubModel({ mode: 'degraded' }));
    // gold pushed to rank 3 of 3: misses @1, still caught @3.
    expect(cellOf(report.overall, 'recall@1').value).toBe(0);
    expect(cellOf(report.overall, 'recall@3').value).toBe(1);
    expect(cellOf(report.overall, 'fragmentation-rate').value!).toBeGreaterThan(0);
    expect(cellOf(report.overall, 'temporal-exact-day').value).toBe(0);
    expect(cellOf(report.overall, 'answer-language-correctness').value).toBe(0);
    expect(cellOf(report.overall, 'over-reject-rate').value).toBe(1);
    expect(cellOf(report.overall, 'hallucination-rate').value).toBe(1);
  });
});

describe('createMultilingualModel — the no-paid-eval spend gate', () => {
  it('default env (no live flag) → StubModel, never a live one', () => {
    expect(createMultilingualModel({}).kind).toBe('stub');
    expect(createMultilingualModel({ OPENAI_API_KEY: 'sk-real' }).kind).toBe('stub');
  });

  it('isLiveEvalEnabled only trips on an explicit truthy flag', () => {
    expect(isLiveEvalEnabled({})).toBe(false);
    expect(isLiveEvalEnabled({ MULTILINGUAL_EVAL_LIVE: '0' })).toBe(false);
    expect(isLiveEvalEnabled({ MULTILINGUAL_EVAL_LIVE: '1' })).toBe(true);
    expect(isLiveEvalEnabled({ MULTILINGUAL_EVAL_LIVE: 'true' })).toBe(true);
  });

  it('live flag WITHOUT a real key → refuses (throws), never a silent fallback', () => {
    expect(() => createMultilingualModel({ MULTILINGUAL_EVAL_LIVE: '1' })).toThrow(
      /refusing to construct a live model/i,
    );
  });

  it('live flag WITH a real key → RealModel, but predict is unbuilt (no paid call)', () => {
    const model = createMultilingualModel({
      MULTILINGUAL_EVAL_LIVE: '1',
      OPENAI_API_KEY: 'sk-real',
    });
    expect(model.kind).toBe('real');
    expect(model).toBeInstanceOf(RealModel);
    expect(() => model.predict(multilingualMatrix[0]!)).toThrow(/not implemented in Tier 0/i);
  });
});

describe('MultilingualReporter', () => {
  const report = runner.run(multilingualMatrix, new StubModel({ mode: 'perfect' }));
  const reporter = new MultilingualReporter();

  it('render() emits a markdown table with the model kind and metric columns', () => {
    const md = reporter.render(report);
    expect(md).toContain('## Multilingual Eval Matrix (stub)');
    expect(md).toContain('recall@1');
    expect(md).toContain('### Language-attribution telemetry');
    expect(md).toContain('| **all** |');
  });

  it('serialize() emits a stable schema-versioned object', () => {
    const ser = reporter.serialize(report);
    expect(ser.schemaVersion).toBe(1);
    expect(ser.modelKind).toBe('stub');
    expect(ser.overall.length).toBe(report.overall.length);
    expect(ser.slices.length).toBe(report.slices.length);
  });
});
