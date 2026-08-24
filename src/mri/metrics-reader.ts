/**
 * MetricsReader — the narrow, stubbable telemetry-source layer the MRI
 * aggregator and the economics collector read from. It is a pure read view
 * over a Prometheus snapshot: no live per-request hooks, no serving-path
 * touch. The production reader is built from `MetricsService.registry`'s
 * `getMetricsAsJSON()` output; unit tests hand-build the same JSON shape, so
 * the aggregator is fully exercisable without a running registry.
 */

/** A single label-set + value from a counter/gauge series. */
export interface CounterSeries {
  labels: Record<string, string>;
  value: number;
}

/** A histogram flattened to cumulative buckets + sum + count. */
export interface HistogramData {
  /** Cumulative buckets, ascending `le`, including +Inf as Number.POSITIVE_INFINITY. */
  buckets: Array<{ le: number; cumulativeCount: number }>;
  sum: number;
  count: number;
}

export interface MetricsReader {
  /** All series for a counter/gauge metric by name (empty if absent). */
  counter(name: string): CounterSeries[];
  /** Histogram data for a metric by name, or null if absent / has no samples. */
  histogram(name: string): HistogramData | null;
}

/** The subset of prom-client's `getMetricsAsJSON()` element shape we consume. */
export interface PromMetricJson {
  name: string;
  type: string;
  values: Array<{
    value: number;
    labels?: Record<string, string | number> | undefined;
    metricName?: string | undefined;
  }>;
}

/** The `registry.getMetricsAsJSON()` surface — kept tiny so callers can stub it. */
export interface PromRegistryLike {
  getMetricsAsJSON(): Promise<PromMetricJson[]>;
}

function normLabels(labels: Record<string, string | number> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;
  for (const [k, v] of Object.entries(labels)) out[k] = String(v);
  return out;
}

/**
 * Build a MetricsReader from a prom-client JSON snapshot. Counters/gauges map
 * straight through; histograms are re-assembled from their `_bucket` (with the
 * `le` label), `_sum`, and `_count` value rows into a HistogramData.
 */
export function readerFromPromJson(metrics: PromMetricJson[]): MetricsReader {
  const byName = new Map<string, PromMetricJson>();
  for (const m of metrics) byName.set(m.name, m);

  return {
    counter(name: string): CounterSeries[] {
      const m = byName.get(name);
      if (!m) return [];
      return m.values
        .filter((v) => v.metricName === undefined || v.metricName === name)
        .map((v) => ({ labels: normLabels(v.labels), value: v.value }));
    },
    histogram(name: string): HistogramData | null {
      const m = byName.get(name);
      if (!m) return null;
      const buckets: Array<{ le: number; cumulativeCount: number }> = [];
      let sum = 0;
      let count = 0;
      for (const v of m.values) {
        const metricName = v.metricName ?? name;
        if (metricName === `${name}_bucket`) {
          const leRaw = v.labels?.['le'];
          if (leRaw === undefined) continue;
          const le = leRaw === '+Inf' ? Number.POSITIVE_INFINITY : Number(leRaw);
          if (Number.isNaN(le)) continue;
          buckets.push({ le, cumulativeCount: v.value });
        } else if (metricName === `${name}_sum`) {
          sum = v.value;
        } else if (metricName === `${name}_count`) {
          count = v.value;
        }
      }
      if (buckets.length === 0 && count === 0) return null;
      buckets.sort((a, b) => a.le - b.le);
      return { buckets, sum, count };
    },
  };
}

/**
 * Sum a counter's series, optionally filtered to series that match ALL of the
 * given labels. Missing metric → 0 (honest: no traffic recorded).
 */
export function sumCounter(
  reader: MetricsReader,
  name: string,
  match?: Record<string, string>,
): number {
  const series = reader.counter(name);
  let total = 0;
  for (const s of series) {
    if (match && !Object.entries(match).every(([k, v]) => s.labels[k] === v)) continue;
    total += s.value;
  }
  return total;
}

/**
 * Prometheus-style `histogram_quantile`: linear interpolation within the bucket
 * where the cumulative count crosses `q · count`. Returns null when the
 * histogram has no samples. This is the same estimator Prometheus uses — an
 * honest approximation off the emitted buckets, not a claimed exact latency.
 */
export function histogramQuantile(hist: HistogramData, q: number): number | null {
  if (hist.count <= 0 || hist.buckets.length === 0) return null;
  const target = q * hist.count;
  const buckets = hist.buckets;

  let prevLe = 0;
  let prevCount = 0;
  for (const b of buckets) {
    if (b.cumulativeCount >= target) {
      if (b.le === Number.POSITIVE_INFINITY) {
        // Everything past the last finite bound sits in +Inf — report that
        // bound (the largest finite bucket edge) rather than Infinity.
        return prevLe;
      }
      const bucketCount = b.cumulativeCount - prevCount;
      if (bucketCount <= 0) return b.le;
      const fraction = (target - prevCount) / bucketCount;
      return prevLe + fraction * (b.le - prevLe);
    }
    prevLe = b.le === Number.POSITIVE_INFINITY ? prevLe : b.le;
    prevCount = b.cumulativeCount;
  }
  return prevLe;
}
