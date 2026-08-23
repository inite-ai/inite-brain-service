import type { DecisionKind, Layer1Signals } from './types';
import {
  DEFAULT_FEATURE_CONFIG,
  featurize,
  type FeatureConfig,
} from './gate-features';
import { GATE_KINDS, type GateModel, type LinearHead } from './gate-classifier';

/**
 * Code-memory track C — train the Layer-1 gate (logistic regression, SGD).
 * (docs/code-memory/distillation-dataset.md)
 *
 * Pure + deterministic (seeded PRNG shuffle) so training is reproducible and
 * unit-testable offline. Trains the binary decision-bearing head plus, when the
 * silver examples carry `kinds`, one-vs-rest heads for each decision kind
 * (decided/because/invariant/gotcha) — a multi-label view for routing/analytics.
 */

export interface TrainExample {
  text: string;
  signals: Layer1Signals;
  label: 0 | 1;
  /** Decision kinds the teacher found (for the multi-label heads). */
  kinds?: DecisionKind[];
}

export interface TrainOptions {
  config?: FeatureConfig;
  epochs?: number;
  learningRate?: number;
  l2?: number;
  threshold?: number;
  /** Threshold for the per-kind heads (default 0.5). */
  kindThreshold?: number;
  seed?: number;
  pruneBelow?: number;
  /** Set false to skip the per-kind heads even when examples carry kinds. */
  trainKinds?: boolean;
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
    // i ∈ [1, len-1], j ∈ [0, i] ⇒ both indices are in-bounds.
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

/** Train one logistic-regression head over pre-featurized examples. */
function trainLogistic(
  feats: Array<Map<number, number>>,
  targets: number[],
  opts: Required<
    Pick<TrainOptions, 'epochs' | 'learningRate' | 'l2' | 'seed' | 'pruneBelow'>
  >,
): LinearHead {
  const { epochs, learningRate: lr, l2, seed, pruneBelow } = opts;
  const rng = mulberry32(seed);
  const weights = new Map<number, number>();
  let bias = 0;
  const order = feats.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch++) {
    shuffle(order, rng);
    for (const i of order) {
      const f = feats[i];
      const y = targets[i];
      // feats/targets are parallel; skip any row whose pair is missing.
      if (f === undefined || y === undefined) continue;
      let z = bias;
      for (const [k, v] of f) z += (weights.get(k) ?? 0) * v;
      const p = 1 / (1 + Math.exp(-z));
      const g = p - y;
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
  return { bias, weights: sparse };
}

export function trainGate(
  examples: TrainExample[],
  opts: TrainOptions = {},
): GateModel {
  const config = opts.config ?? DEFAULT_FEATURE_CONFIG;
  const seed = opts.seed ?? 42;
  const base = {
    epochs: opts.epochs ?? 25,
    learningRate: opts.learningRate ?? 0.1,
    l2: opts.l2 ?? 1e-4,
    pruneBelow: opts.pruneBelow ?? 1e-5,
  };
  const feats = examples.map((e) => featurize(e.text, e.signals, config));

  // Binary decision-bearing head (seed unchanged → same weights as a v1 train).
  const binary = trainLogistic(feats, examples.map((e) => e.label), {
    ...base,
    seed,
  });

  const model: GateModel = {
    version: 1,
    config,
    threshold: opts.threshold ?? 0.5,
    bias: binary.bias,
    weights: binary.weights,
  };

  // Per-kind one-vs-rest heads when the corpus carries kinds.
  const trainKinds =
    opts.trainKinds !== false &&
    examples.some((e) => e.kinds && e.kinds.length > 0);
  if (trainKinds) {
    const kinds: Partial<Record<DecisionKind, LinearHead>> = {};
    GATE_KINDS.forEach((kind, i) => {
      const targets = examples.map((e) => (e.kinds?.includes(kind) ? 1 : 0));
      if (targets.some((t) => t === 1)) {
        // Distinct seed per head so they don't share a shuffle sequence.
        kinds[kind] = trainLogistic(feats, targets, { ...base, seed: seed + i + 1 });
      }
    });
    if (Object.keys(kinds).length > 0) {
      model.version = 2;
      model.kinds = kinds;
      model.kindThreshold = opts.kindThreshold ?? 0.5;
    }
  }

  return model;
}
