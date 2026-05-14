/**
 * Bootstrap confidence interval for a sample-mean metric.
 *
 * Why: every retrieval metric in this harness (recall@k, MRR, NDCG)
 * is a mean over a small N (sometimes 5-10 queries per vertical).
 * A point estimate of "recall=0.60" on N=5 hides that the true value
 * could be anywhere from 0.30 to 0.90. Without CI, every PR that
 * shifts one query reads as a regression — which is exactly the
 * estate=0.80→0.60 noise that prompted this.
 *
 * Algorithm: percentile bootstrap (Efron 1979). Resample the input
 * vector with replacement B times, compute the statistic on each
 * resample, take the (α/2, 1-α/2) percentiles. Default B=1000,
 * α=0.05 → 95% CI.
 *
 * Pure function, no IO. Uses mulberry32 PRNG seeded by `seed`
 * argument so the CI itself is reproducible across runs (a varying
 * CI is a worse problem than a varying point estimate).
 *
 * Returns null bounds when the input is empty or B<2 — the metric
 * layer surfaces null as "—".
 */

export interface BootstrapCI {
  /** 0..1 confidence level. Default 0.95. */
  level: number;
  lower: number | null;
  upper: number | null;
  /** Number of resamples used. Reported so a low-B run is debuggable. */
  resamples: number;
}

export interface BootstrapOptions {
  /** Number of resamples. Default 1000. */
  B?: number;
  /** Confidence level. Default 0.95. */
  level?: number;
  /** PRNG seed. Default 42. */
  seed?: number;
}

/**
 * Bootstrap CI for the mean of a numeric vector. The statistic is
 * always sample-mean (the only one this harness uses); other
 * statistics can be added when needed.
 */
export function bootstrapMeanCI(
  values: number[],
  opts: BootstrapOptions = {},
): BootstrapCI {
  const B = opts.B ?? 1000;
  const level = opts.level ?? 0.95;
  const seed = opts.seed ?? 42;

  if (values.length === 0 || B < 2) {
    return { level, lower: null, upper: null, resamples: 0 };
  }
  if (values.length === 1) {
    // CI for a single observation is the observation itself —
    // any percentile is the same value. Surface this as a bound
    // pair so callers don't crash on null arithmetic.
    return { level, lower: values[0], upper: values[0], resamples: 0 };
  }

  const rand = mulberry32(seed);
  const n = values.length;
  const means = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      sum += values[idx];
    }
    means[b] = sum / n;
  }
  // Percentile bootstrap.
  means.sort();
  const alpha = 1 - level;
  const lowerIdx = Math.floor((alpha / 2) * B);
  const upperIdx = Math.min(B - 1, Math.ceil((1 - alpha / 2) * B) - 1);
  return {
    level,
    lower: means[lowerIdx],
    upper: means[upperIdx],
    resamples: B,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
