import type { MetricsReader, PromMetricJson } from './metrics-reader';
import { readerFromPromJson } from './metrics-reader';

/**
 * Windowed telemetry for the MRI report (R3 P1).
 *
 * Prometheus counters are process-lifetime, MONOTONIC accumulators. Dividing
 * two of them (e.g. ok / terminal, tokens / requests) yields a rate over the
 * WHOLE process lifetime -- it silently folds in ancient traffic and drifts as
 * the process ages, so a "per query" cell means less and less the longer the
 * process runs. The MRI live cells must instead reflect a bounded RECENT window.
 *
 * We window by DELTA over a rolling baseline: keep timestamped snapshots of the
 * raw counter JSON, and on each report subtract the oldest snapshot still inside
 * the window from the current one. Counters are monotonic, so the delta is the
 * traffic that landed IN the window. A series that shrank (process restart /
 * registry reset) is clamped to its current value (reset-safe). Histograms delta
 * the same way -- cumulative bucket/sum/count differences are a valid histogram
 * over the window.
 *
 * This layer is READ-ONLY: it only reads snapshots the pipeline already emits;
 * it never touches the serving path.
 */

/** A timestamped raw-counter snapshot. */
export interface CounterSnapshot {
  /** Epoch milliseconds the snapshot was taken. */
  at: number;
  metrics: PromMetricJson[];
}

/** Default rolling window: 1 hour. A per-query rate over the last hour is
 *  meaningful for an advisory admin report; older traffic is dropped. */
export const DEFAULT_MRI_WINDOW_MS = 60 * 60 * 1000;

/** Hard cap on retained snapshots so a pathological tight poll loop cannot grow
 *  memory without bound. Dropping the oldest only ever SHRINKS the window (never
 *  lengthens it), which is the safe direction: recent data, never ancient. */
export const MAX_SNAPSHOTS = 512;

/** Internal map-key field separator. A printable delimiter that cannot appear in
 *  a Prometheus metric name / series / `k=v` label pair, so keys never collide. */
const SEP = '||';

function labelKey(labels: Record<string, string | number> | undefined): string {
  if (!labels) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join(',');
}

/** Index a snapshot's every value by (metric, series, labels) -> value. */
function indexSnapshot(metrics: PromMetricJson[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (const m of metrics) {
    for (const v of m.values) {
      const series = v.metricName ?? m.name;
      idx.set(`${m.name}${SEP}${series}${SEP}${labelKey(v.labels)}`, v.value);
    }
  }
  return idx;
}

/**
 * current - baseline, per (metric, series, labels). A missing baseline series ->
 * keep current (all of it is in-window). A negative delta (counter reset) ->
 * clamp to current. `baseline === null` -> pass current through unchanged.
 */
export function deltaSnapshots(
  current: PromMetricJson[],
  baseline: PromMetricJson[] | null,
): PromMetricJson[] {
  if (baseline === null) return current;
  const base = indexSnapshot(baseline);
  return current.map((m) => ({
    ...m,
    values: m.values.map((v) => {
      const series = v.metricName ?? m.name;
      const prev = base.get(`${m.name}${SEP}${series}${SEP}${labelKey(v.labels)}`);
      const delta = prev === undefined ? v.value : v.value - prev;
      return { ...v, value: delta < 0 ? v.value : delta };
    }),
  }));
}

/** A windowed reader over the delta between the current snapshot and a baseline. */
export function windowedReader(
  current: PromMetricJson[],
  baseline: PromMetricJson[] | null,
): MetricsReader {
  return readerFromPromJson(deltaSnapshots(current, baseline));
}

/** The window an `observe()` resolved: the baseline to delta against + bounds. */
export interface WindowResult {
  /** The baseline snapshot the delta is taken against (never null once
   *  observed -- the first observation baselines against itself -> span 0). */
  baseline: CounterSnapshot;
  startedAt: string;
  endedAt: string;
  windowMs: number;
}

/**
 * A rolling snapshot ring. `observe(metrics, now)` records the current snapshot,
 * prunes snapshots older than the window (and beyond MAX_SNAPSHOTS), and returns
 * the oldest still-retained snapshot as the delta baseline.
 *
 * The FIRST observation baselines against itself (window span 0) -- so the report
 * honestly renders "no traffic in the window yet" rather than a lifetime rate.
 * Once a poll >= windowMs old exists the window is a true rolling window; if polls
 * stop for longer than the window, the ring empties and the next poll re-opens a
 * fresh (empty) window rather than reporting a stale multi-window rate.
 */
export class SnapshotWindow {
  private readonly snapshots: CounterSnapshot[] = [];

  constructor(private readonly windowMs: number = DEFAULT_MRI_WINDOW_MS) {}

  observe(metrics: PromMetricJson[], now: Date): WindowResult {
    const at = now.getTime();
    this.snapshots.push({ at, metrics });

    // Drop snapshots older than the window (always keep the current one).
    const cutoff = at - this.windowMs;
    while (this.snapshots.length > 1 && this.snapshots[0]!.at < cutoff) {
      this.snapshots.shift();
    }
    // Memory backstop: never retain more than MAX_SNAPSHOTS.
    while (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }

    const baseline = this.snapshots[0]!;
    return {
      baseline,
      startedAt: new Date(baseline.at).toISOString(),
      endedAt: now.toISOString(),
      windowMs: this.windowMs,
    };
  }
}
