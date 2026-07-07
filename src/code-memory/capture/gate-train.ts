import type { Layer1Signals } from './types';
import {
  DEFAULT_FEATURE_CONFIG,
  featurize,
  type FeatureConfig,
} from './gate-features';
import type { GateModel } from './gate-classifier';

/**
 * Code-memory track C — train the Layer-1 gate (logistic regression, SGD).
 * (docs/code-memory/distillation-dataset.md)
 *
 * Pure + deterministic (seeded PRNG shuffle) so training is reproducible and
 * unit-testable offline. Trains on the silver labels the harness distilled from
 * the Layer-2 teacher; the resulting {@link GateModel} serves behind
 * TrainedDecisionClassifier.
 */

export interface TrainExample {
  text: string;
  signals: Layer1Signals;
  label: 0 | 1;
}

export interface TrainOptions {
  config?: FeatureConfig;
  epochs?: number;
  learningRate?: number;
  l2?: number;
  threshold?: number;
  seed?: number;
  /** Drop weights with |w| below this after training to shrink the artifact. */
  pruneBelow?: number;
}

/** Deterministic PRNG (mulberry32) — reproducible shuffles without Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function trainGate(
  examples: TrainExample[],
  opts: TrainOptions = {},
): GateModel {
  const config = opts.config ?? DEFAULT_FEATURE_CONFIG;
  const epochs = opts.epochs ?? 25;
  const lr = opts.learningRate ?? 0.1;
  const l2 = opts.l2 ?? 1e-4;
  const threshold = opts.threshold ?? 0.5;
  const pruneBelow = opts.pruneBelow ?? 1e-5;
  const rng = mulberry32(opts.seed ?? 42);

  const feats = examples.map((e) => featurize(e.text, e.signals, config));
  const weights = new Map<number, number>();
  let bias = 0;
  const order = examples.map((_, i) => i);

  for (let epoch = 0; epoch < epochs; epoch++) {
    shuffle(order, rng);
    for (const i of order) {
      const f = feats[i];
      const y = examples[i].label;
      let z = bias;
      for (const [k, v] of f) z += (weights.get(k) ?? 0) * v;
      const p = 1 / (1 + Math.exp(-z));
      const g = p - y; // dLoss/dz for logistic loss
      bias -= lr * g;
      for (const [k, v] of f) {
        const w = weights.get(k) ?? 0;
        weights.set(k, w - lr * (g * v + l2 * w));
      }
    }
  }

  const sparse: Record<string, number> = {};
  for (const [k, w] of weights) {
    if (Math.abs(w) >= pruneBelow) sparse[k] = w;
  }
  return { version: 1, config, threshold, bias, weights: sparse };
}
