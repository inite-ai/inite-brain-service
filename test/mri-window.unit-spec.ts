/**
 * MRI windowed telemetry (src/mri/mri-window.ts) — R3 P1.
 *
 * Prometheus counters are process-lifetime accumulators; a rate off two of them
 * silently folds in ancient traffic. These specs pin the delta-over-baseline
 * windowing: the reader reflects only traffic IN the window, resets are
 * clamped, new series pass through, and a rolling window drops ancient
 * baselines so an aged process never reports a lifetime rate.
 */
import { sumCounter } from '../src/mri/metrics-reader';
import type { PromMetricJson } from '../src/mri/metrics-reader';
import { deltaSnapshots, windowedReader, SnapshotWindow } from '../src/mri/mri-window';

function synth(ok: number, tokens?: number): PromMetricJson[] {
  const out: PromMetricJson[] = [
    {
      name: 'brain_synthesize_total',
      type: 'counter',
      values: [{ value: ok, labels: { outcome: 'ok' } }],
    },
  ];
  if (tokens !== undefined) {
    out.push({
      name: 'brain_openai_tokens_total',
      type: 'counter',
      values: [{ value: tokens, labels: { kind: 'chat', type: 'prompt' } }],
    });
  }
  return out;
}

const okOf = (m: PromMetricJson[]): number =>
  sumCounter(windowedReader(m, null), 'brain_synthesize_total', { outcome: 'ok' });

describe('deltaSnapshots — current − baseline per (metric, labels)', () => {
  it('subtracts the baseline so the reader reflects only in-window traffic', () => {
    const reader = windowedReader(synth(150), synth(100));
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(50);
  });

  it('passes current through unchanged when there is no baseline', () => {
    const delta = deltaSnapshots(synth(150), null);
    expect(delta).toEqual(synth(150));
    expect(okOf(delta)).toBe(150);
  });

  it('clamps a counter that shrank (process restart / registry reset) to current', () => {
    // baseline ok=200 > current ok=50 → the counter reset; the window is the
    // current value, never a negative rate.
    const reader = windowedReader(synth(50), synth(200));
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(50);
  });

  it('keeps a series absent from the baseline (all of it is in-window)', () => {
    const reader = windowedReader(synth(150, 5000), synth(100)); // no tokens at baseline
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(50);
    expect(sumCounter(reader, 'brain_openai_tokens_total')).toBe(5000);
  });
});

describe('SnapshotWindow — rolling window over process-lifetime counters', () => {
  const t = (ms: number) => new Date(1_000_000 + ms);

  it('first observation baselines against itself → window span 0, no traffic', () => {
    const w = new SnapshotWindow(1000);
    const r = w.observe(synth(100), t(0));
    expect(r.startedAt).toBe(r.endedAt); // span 0
    const reader = windowedReader(synth(100), r.baseline.metrics);
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(0);
  });

  it('a subsequent poll inside the window reports the delta since the baseline', () => {
    const w = new SnapshotWindow(1000);
    w.observe(synth(100), t(0));
    const r = w.observe(synth(160), t(500));
    const reader = windowedReader(synth(160), r.baseline.metrics);
    // baseline is the t0 snapshot (ok=100) → delta 60.
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(60);
  });

  it('drops an ANCIENT baseline so an aged process never reports a lifetime rate', () => {
    const w = new SnapshotWindow(1000);
    w.observe(synth(100), t(0)); // ancient
    w.observe(synth(200), t(900)); // still inside window at t=1600? no — see cutoff
    const r = w.observe(synth(260), t(1600));
    // cutoff = 1600 − 1000 = 600; t0(0) and t500... here t900 ≥ 600 stays,
    // t0 is pruned. baseline = t900 snapshot (ok=200) → delta 60, NOT 160.
    const reader = windowedReader(synth(260), r.baseline.metrics);
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(60);
    // the window start advanced past the ancient t0 snapshot
    expect(new Date(r.startedAt).getTime()).toBe(t(900).getTime());
  });

  it('re-opens a fresh empty window when polling stops for longer than the window', () => {
    const w = new SnapshotWindow(1000);
    w.observe(synth(100), t(0));
    const r = w.observe(synth(500), t(5000)); // 5s gap ≫ 1s window
    // Only the current snapshot remains → baseline is itself → delta 0 rather
    // than a stale multi-window rate.
    const reader = windowedReader(synth(500), r.baseline.metrics);
    expect(sumCounter(reader, 'brain_synthesize_total', { outcome: 'ok' })).toBe(0);
    expect(r.startedAt).toBe(r.endedAt);
  });
});
