/**
 * MRI aggregator (Part 2) — unit coverage with a STUB metrics/source layer.
 *
 * Proves the inviolable rule mechanically: free dimensions compute REAL numbers
 * off the stub telemetry; eval-gated dimensions render `pending-eval`; freshness
 * renders the F1-blocked reason; structural dimensions render the ledger's
 * recorded status (or `unrecorded`, never a guessed pass); and every
 * `pending-eval` / sentinel cell carries a reason.
 */
import { buildMriReport } from '../src/mri/mri-collectors';
import type { CounterSeries, HistogramData, MetricsReader } from '../src/mri/metrics-reader';
import type { SuiteLedger } from '../src/mri/suite-status';

function stubReader(opts: {
  counters?: Record<string, CounterSeries[]>;
  histograms?: Record<string, HistogramData>;
}): MetricsReader {
  return {
    counter: (name) => opts.counters?.[name] ?? [],
    histogram: (name) => opts.histograms?.[name] ?? null,
  };
}

const LATENCY_HIST: HistogramData = {
  buckets: [
    { le: 0.05, cumulativeCount: 10 },
    { le: 0.1, cumulativeCount: 50 },
    { le: 0.25, cumulativeCount: 90 },
    { le: 0.5, cumulativeCount: 98 },
    { le: Number.POSITIVE_INFINITY, cumulativeCount: 100 },
  ],
  sum: 12,
  count: 100,
};

function busyReader(extra: Record<string, CounterSeries[]> = {}): MetricsReader {
  return stubReader({
    counters: {
      brain_synthesize_total: [
        { labels: { outcome: 'ok' }, value: 80 },
        { labels: { outcome: 'verifier_failed' }, value: 20 },
      ],
      brain_openai_tokens_total: [
        { labels: { kind: 'chat', type: 'prompt' }, value: 100_000 },
        { labels: { kind: 'chat', type: 'completion' }, value: 20_000 },
        { labels: { kind: 'embed', type: 'prompt' }, value: 5_000 },
      ],
      ...extra,
    },
    histograms: { brain_search_duration_seconds: LATENCY_HIST },
  });
}

const GREEN_LEDGER: SuiteLedger = {
  'memtrap-shakedown': {
    status: 'pass',
    numPassed: 6,
    numFailed: 0,
    recordedAt: '2026-08-20T00:00:00.000Z',
    commit: 'abc1234',
  },
  'minja-redteam': { status: 'pass', gapCount: 0, recordedAt: '2026-08-20T00:00:00.000Z' },
  'tenant-user-isolation': {
    status: 'pass',
    numPassed: 12,
    numFailed: 0,
    recordedAt: '2026-08-20T00:00:00.000Z',
  },
};

describe('buildMriReport — free (live telemetry) dimensions', () => {
  const report = buildMriReport(busyReader(), GREEN_LEDGER, {
    now: new Date('2026-08-24T12:00:00.000Z'),
  });

  it('tokens/query is a real number off the token counters (÷ terminal count)', () => {
    const d = report.dimensions.tokensPerQuery!;
    expect(d.value).toBe(1250); // 125,000 tokens / 100 terminal requests
    expect(d.unit).toBe('tokens/query (all-AI upper bound)');
    expect(d.kind).toBe('live');
    expect(d.evalGated).toBe(false);
  });

  it('cost/query is an UPPER BOUND off exact token counts × the price table', () => {
    const d = report.dimensions.costPerQueryUpperBoundUsd!;
    // (100000*0.15 + 20000*0.6 + 5000*0.02)/1e6 / 100 terminal = 0.000271
    expect(typeof d.value).toBe('number');
    expect(d.value as number).toBeCloseTo(0.000271, 9);
    expect(d.unit).toBe('USD/query (all-AI upper bound)');
    expect(d.source).toMatch(/UPPER BOUND/);
  });

  it('p50/p95 latency render pending — no serving-path histogram is emitted', () => {
    for (const key of ['latencyP50Seconds', 'latencyP95Seconds'] as const) {
      const d = report.dimensions[key]!;
      expect(d.value).toBe('pending-eval');
      expect(d.kind).toBe('pending');
      expect(d.reason).toMatch(/no per-query latency histogram is emitted on the serving path/);
    }
  });

  it('exposes a live operating point (proxy-accuracy = ok ÷ terminal); latency null', () => {
    const p = report.operatingPoint;
    expect(p.accuracyProxy).toBeCloseTo(0.8, 6);
    expect(p.ece).toBeNull();
    expect(p.sampleCount).toBe(100);
    expect(p.latencyP95).toBeNull();
  });
});

describe('buildMriReport — structural (suite-backed) dimensions', () => {
  it('renders the ledger status for a recorded suite', () => {
    const report = buildMriReport(busyReader(), GREEN_LEDGER, {});
    expect(report.dimensions.tenantUserIsolation!.value).toBe('pass');
    // Poisoning prefers the numeric GAP count (0 = no gaps).
    expect(report.dimensions.poisoningResistance!.value).toBe(0);
    expect(report.dimensions.poisoningResistance!.unit).toBe('gaps');
  });

  it('renders `unrecorded` (never a guessed pass) when the ledger is empty', () => {
    const report = buildMriReport(busyReader(), {}, {});
    for (const key of ['poisoningResistance', 'tenantUserIsolation'] as const) {
      const d = report.dimensions[key]!;
      expect(d.value).toBe('unrecorded');
      expect(d.reason).toMatch(/mri:record-suite/);
    }
  });
});

describe('buildMriReport — premiseAwareness reflects the DEFENSE state, not a suite pass', () => {
  it('renders `exposed` (never a green pass) when FOVEA_PLAUSIBILITY_CHECK is off', () => {
    // A GREEN MemTrap suite documents current EXPOSURES (incl. the served
    // belief-distortion answer). Suite-pass is NOT premise-awareness.
    const report = buildMriReport(busyReader(), GREEN_LEDGER, {
      plausibilityCheckEnabled: false,
    });
    const d = report.dimensions.premiseAwareness!;
    expect(d.value).toBe('exposed');
    expect(d.value).not.toBe('pass');
    expect(d.reason).toMatch(/belief-distortion/);
    expect(d.reason).toMatch(/not a pass/);
  });

  it('defaults to `exposed` when the defense state is unknown (conservative)', () => {
    const d = buildMriReport(busyReader(), GREEN_LEDGER, {}).dimensions.premiseAwareness!;
    expect(d.value).toBe('exposed');
  });

  it('renders `defended` + live downgrade count when the defense is on', () => {
    const withCounter = busyReader({
      brain_plausibility_downgrade_total: [{ labels: {}, value: 7 }],
    });
    const d = buildMriReport(withCounter, GREEN_LEDGER, {
      plausibilityCheckEnabled: true,
    }).dimensions.premiseAwareness!;
    expect(d.value).toBe('defended');
    expect(d.kind).toBe('live');
    expect(d.source).toMatch(/downgrades=7/);
  });

  it('defense on but no downgrades observed → `defended` with an activity note', () => {
    const d = buildMriReport(busyReader(), GREEN_LEDGER, {
      plausibilityCheckEnabled: true,
    }).dimensions.premiseAwareness!;
    expect(d.value).toBe('defended');
    expect(d.source).toMatch(/downgrades=0/);
    expect(d.reason).toMatch(/no supported-answer downgrades/);
  });
});

describe('buildMriReport — pending dimensions carry an honest reason', () => {
  const report = buildMriReport(busyReader(), GREEN_LEDGER, {});

  it('freshness is F1-blocked (not built here)', () => {
    const d = report.dimensions.freshnessStaleAnswerRate!;
    expect(d.value).toBe('pending-eval');
    expect(d.reason).toMatch(/F1 answer-cache/);
    expect(d.kind).toBe('pending');
  });

  it('correctness + abstention are eval-gated', () => {
    expect(report.dimensions.correctness!.value).toBe('pending-eval');
    expect(report.dimensions.correctness!.evalGated).toBe(true);
    expect(report.dimensions.abstentionCalibration!.value).toBe('pending-eval');
    expect(report.dimensions.abstentionCalibration!.evalGated).toBe(true);
  });

  it('citation coverage renders pending until the serving path emits the counter', () => {
    const d = report.dimensions.citationCoverage!;
    expect(d.value).toBe('pending-eval');
    expect(d.reason).toMatch(/serving path/);
  });

  it('citation coverage auto-fills when the counters appear', () => {
    const withCite = busyReader({
      brain_synthesize_supported_total: [{ labels: {}, value: 50 }],
      brain_synthesize_supported_cited_total: [{ labels: {}, value: 45 }],
    });
    const d = buildMriReport(withCite, GREEN_LEDGER, {}).dimensions.citationCoverage!;
    expect(d.value as number).toBeCloseTo(0.9, 6);
    expect(d.kind).toBe('live');
  });

  it('every non-numeric sentinel cell carries a reason (the inviolable rule)', () => {
    for (const d of Object.values(report.dimensions)) {
      if (typeof d.value === 'string' && (d.value === 'pending-eval' || d.value === 'unrecorded')) {
        expect(typeof d.reason).toBe('string');
        expect(d.reason!.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildMriReport — empty window never fabricates a number', () => {
  const report = buildMriReport(stubReader({}), {}, {});

  it('live cells render pending (0 queries), not a fake zero', () => {
    expect(report.dimensions.tokensPerQuery!.value).toBe('pending-eval');
    expect(report.dimensions.costPerQueryUpperBoundUsd!.value).toBe('pending-eval');
    expect(report.dimensions.latencyP95Seconds!.value).toBe('pending-eval');
    expect(report.operatingPoint.accuracyProxy).toBeNull();
    expect(report.operatingPoint.sampleCount).toBe(0);
  });
});
