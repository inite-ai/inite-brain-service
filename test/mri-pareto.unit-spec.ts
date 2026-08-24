/**
 * Part 1 economics — operating-point collector, Pareto reporter, advisory
 * ship-gate, and the telemetry reader / histogram-quantile it rests on.
 */
import {
  collectOperatingPoint,
  dominates,
  paretoFrontier,
  shipGateAdvisory,
  type PolicyOperatingPoint,
} from '../src/mri/economics';
import {
  histogramQuantile,
  readerFromPromJson,
  type PromMetricJson,
} from '../src/mri/metrics-reader';

function point(over: Partial<PolicyOperatingPoint>): PolicyOperatingPoint {
  return {
    flags: [],
    accuracyProxy: 0.8,
    ece: null,
    latencyP50: 0.1,
    latencyP95: 0.2,
    costPerQueryUpperBound: 0.01,
    sampleCount: 100,
    ...over,
  };
}

const A = point({
  flags: ['a'],
  accuracyProxy: 0.8,
  latencyP95: 0.2,
  costPerQueryUpperBound: 0.01,
});
const B = point({
  flags: ['b'],
  accuracyProxy: 0.7,
  latencyP95: 0.3,
  costPerQueryUpperBound: 0.02,
}); // dominated by A
const C = point({
  flags: ['c'],
  accuracyProxy: 0.9,
  latencyP95: 0.5,
  costPerQueryUpperBound: 0.05,
}); // frontier
const D = point({ flags: ['d'], latencyP95: null, costPerQueryUpperBound: null }); // missing axes

describe('paretoFrontier', () => {
  it('separates frontier, dominated, and insufficient-data points', () => {
    const r = paretoFrontier([A, B, C, D]);
    expect(r.frontier.map((p) => p.flags[0]).sort()).toEqual(['a', 'c']);
    expect(r.dominated).toHaveLength(1);
    expect(r.dominated[0]!.point.flags[0]).toBe('b');
    expect(r.dominated[0]!.dominatedBy.flags[0]).toBe('a');
    expect(r.insufficientData.map((p) => p.flags[0])).toEqual(['d']);
  });

  it('dominates() is true only when weakly-better everywhere + strictly-better once', () => {
    expect(dominates(A, B)).toBe(true);
    expect(dominates(A, C)).toBe(false); // A cheaper/faster but lower accuracy
    expect(dominates(C, A)).toBe(false);
    expect(dominates(A, D)).toBe(false); // D has null axes
  });
});

describe('shipGateAdvisory — advisory only, never blocks', () => {
  it('flags a dominated candidate but does not block', () => {
    const g = shipGateAdvisory(B, [A, C]);
    expect(g.candidateDominated).toBe(true);
    expect(g.dominatedBy?.flags[0]).toBe('a');
    expect(g.blocking).toBe(false);
    expect(g.advisory).toMatch(/DOMINATED/);
  });

  it('passes a frontier candidate, still non-blocking', () => {
    const g = shipGateAdvisory(C, [A]);
    expect(g.candidateDominated).toBe(false);
    expect(g.blocking).toBe(false);
  });

  it('reports insufficient data (not a domination verdict) for a null-axis candidate', () => {
    const g = shipGateAdvisory(D, [A]);
    expect(g.candidateDominated).toBe(false);
    expect(g.blocking).toBe(false);
    expect(g.advisory).toMatch(/no telemetry/);
  });
});

describe('collectOperatingPoint — from a telemetry reader', () => {
  const json: PromMetricJson[] = [
    {
      name: 'brain_synthesize_total',
      type: 'counter',
      values: [
        { value: 80, labels: { outcome: 'ok' } },
        { value: 20, labels: { outcome: 'verifier_failed' } },
      ],
    },
    {
      name: 'brain_openai_tokens_total',
      type: 'counter',
      values: [
        { value: 100_000, labels: { kind: 'chat', type: 'prompt' } },
        { value: 20_000, labels: { kind: 'chat', type: 'completion' } },
        { value: 5_000, labels: { kind: 'embed', type: 'prompt' } },
      ],
    },
    {
      name: 'brain_search_duration_seconds',
      type: 'histogram',
      values: [
        { value: 10, labels: { le: '0.05' }, metricName: 'brain_search_duration_seconds_bucket' },
        { value: 50, labels: { le: '0.1' }, metricName: 'brain_search_duration_seconds_bucket' },
        { value: 90, labels: { le: '0.25' }, metricName: 'brain_search_duration_seconds_bucket' },
        { value: 98, labels: { le: '0.5' }, metricName: 'brain_search_duration_seconds_bucket' },
        { value: 100, labels: { le: '+Inf' }, metricName: 'brain_search_duration_seconds_bucket' },
        { value: 12, labels: {}, metricName: 'brain_search_duration_seconds_sum' },
        { value: 100, labels: {}, metricName: 'brain_search_duration_seconds_count' },
      ],
    },
  ];

  it('assembles proxy-accuracy (ok ÷ terminal) + cost upper bound; ece null', () => {
    const p = collectOperatingPoint(readerFromPromJson(json), { flags: ['x'] });
    expect(p.flags).toEqual(['x']);
    expect(p.accuracyProxy).toBeCloseTo(0.8, 6); // 80 ok / 100 terminal
    expect(p.ece).toBeNull();
    expect(p.costPerQueryUpperBound!).toBeCloseTo(0.000271, 9); // all-AI tokens / 100 terminal
    expect(p.sampleCount).toBe(100);
  });

  it('leaves latency null even when a search histogram is present (serving path emits none)', () => {
    // brain_search_duration_seconds is in the snapshot, but the serving path
    // never observes it — so it is not a real per-query latency signal.
    const p = collectOperatingPoint(readerFromPromJson(json));
    expect(p.latencyP50).toBeNull();
    expect(p.latencyP95).toBeNull();
  });

  it('accuracyProxy denominator is the TERMINAL count — intermediate outcomes excluded', () => {
    // A single request can bump brain_synthesize_total more than once: the
    // intermediate generator_truncated / search_loop_refined tags fire alongside
    // a terminal outcome. Raw total here = 80+20+30+40 = 170; terminal = 100.
    const withIntermediate: PromMetricJson[] = [
      {
        name: 'brain_synthesize_total',
        type: 'counter',
        values: [
          { value: 80, labels: { outcome: 'ok' } },
          { value: 20, labels: { outcome: 'verifier_failed' } },
          { value: 30, labels: { outcome: 'search_loop_refined' } }, // intermediate
          { value: 40, labels: { outcome: 'generator_truncated' } }, // intermediate
        ],
      },
    ];
    const p = collectOperatingPoint(readerFromPromJson(withIntermediate));
    expect(p.sampleCount).toBe(100); // terminal only, not 170
    expect(p.accuracyProxy).toBeCloseTo(0.8, 6); // 80 / 100, not 80 / 170
  });

  it('accuracyProxy is null (never a wrong number) when no terminal outcomes exist', () => {
    // Only intermediate outcomes recorded → no per-request denominator derivable.
    const onlyIntermediate: PromMetricJson[] = [
      {
        name: 'brain_synthesize_total',
        type: 'counter',
        values: [{ value: 5, labels: { outcome: 'search_loop_refined' } }],
      },
    ];
    const p = collectOperatingPoint(readerFromPromJson(onlyIntermediate));
    expect(p.sampleCount).toBe(0);
    expect(p.accuracyProxy).toBeNull();
  });

  it('returns nulls (never zeros) for an empty window', () => {
    const p = collectOperatingPoint(readerFromPromJson([]));
    expect(p.accuracyProxy).toBeNull();
    expect(p.costPerQueryUpperBound).toBeNull();
    expect(p.latencyP95).toBeNull();
    expect(p.sampleCount).toBe(0);
  });
});

describe('histogramQuantile', () => {
  it('returns null on an empty histogram', () => {
    expect(histogramQuantile({ buckets: [], sum: 0, count: 0 }, 0.5)).toBeNull();
  });

  it('interpolates within the crossing bucket', () => {
    const hist = readerFromPromJson([
      {
        name: 'h',
        type: 'histogram',
        values: [
          { value: 10, labels: { le: '0.05' }, metricName: 'h_bucket' },
          { value: 50, labels: { le: '0.1' }, metricName: 'h_bucket' },
          { value: 100, labels: { le: '+Inf' }, metricName: 'h_bucket' },
          { value: 5, labels: {}, metricName: 'h_sum' },
          { value: 100, labels: {}, metricName: 'h_count' },
        ],
      },
    ]).histogram('h')!;
    expect(histogramQuantile(hist, 0.5)).toBeCloseTo(0.1, 6);
  });
});
