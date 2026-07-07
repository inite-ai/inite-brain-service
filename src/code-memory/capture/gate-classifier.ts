import type { CommitInput, DecisionClassifier, Layer1Verdict } from './types';
import { parseCommitSignals } from './commit-signals';
import { commitText } from './silver-dataset';
import {
  DEFAULT_FEATURE_CONFIG,
  featurize,
  type FeatureConfig,
} from './gate-features';

/**
 * Code-memory track C — the trained Layer-1 gate model + serving classifier.
 * (docs/code-memory/distillation-dataset.md)
 *
 * A logistic-regression student distilled from the Layer-2 teacher's silver
 * labels. Deliberately a lightweight LINEAR model, not a BiLSTM/DistilBERT: the
 * gate runs client-side with zero ML runtime, the input is short commit text,
 * and a linear model over hashed n-grams + the deterministic signals trains in
 * seconds and serialises to a tiny JSON. A heavier student (DistilBERT via ONNX)
 * can replace it behind this same {@link DecisionClassifier} seam if metrics
 * ever demand — the pipeline never changes.
 */

/** Serialised trained gate. `weights` is sparse (bucket index → weight); only
 *  buckets the trainer touched are stored. Portable JSON, no vocabulary. */
export interface GateModel {
  version: 1;
  config: FeatureConfig;
  /** Admit when P(decision) >= threshold. */
  threshold: number;
  bias: number;
  weights: Record<string, number>;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** P(decision-bearing) for a feature map under a model. */
export function predictProba(
  model: GateModel,
  feats: Map<number, number>,
): number {
  let z = model.bias;
  for (const [idx, val] of feats) {
    const w = model.weights[idx];
    if (w) z += w * val;
  }
  return sigmoid(z);
}

export interface GateMetrics {
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Evaluate a model (or any predictor) against labeled, pre-featurized examples. */
export function evaluateGate(
  model: GateModel,
  examples: Array<{ feats: Map<number, number>; label: 0 | 1 }>,
): GateMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  for (const ex of examples) {
    const pred = predictProba(model, ex.feats) >= model.threshold ? 1 : 0;
    if (pred === ex.label) correct += 1;
    if (pred === 1 && ex.label === 1) tp += 1;
    else if (pred === 1 && ex.label === 0) fp += 1;
    else if (pred === 0 && ex.label === 1) fn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  return {
    n: examples.length,
    accuracy: examples.length > 0 ? correct / examples.length : 0,
    precision,
    recall,
    f1,
  };
}

/**
 * Layer-1 classifier backed by a trained {@link GateModel}. Drop-in replacement
 * for HeuristicDecisionClassifier — same interface, so the capture pipeline is
 * unchanged. Featurizes a commit identically to training and admits when the
 * predicted probability clears the model's threshold.
 */
export class TrainedDecisionClassifier implements DecisionClassifier {
  constructor(private readonly model: GateModel) {}

  /** Build from parsed JSON (a model artifact), validating the shape. */
  static fromJson(raw: unknown): TrainedDecisionClassifier {
    const m = raw as Partial<GateModel>;
    if (
      !m ||
      m.version !== 1 ||
      typeof m.bias !== 'number' ||
      typeof m.threshold !== 'number' ||
      typeof m.weights !== 'object' ||
      m.weights === null ||
      !m.config ||
      typeof m.config.dim !== 'number'
    ) {
      throw new Error('invalid gate model JSON');
    }
    return new TrainedDecisionClassifier(m as GateModel);
  }

  classify(commit: CommitInput): Layer1Verdict {
    const signals = parseCommitSignals(commit);
    const p = predictProba(
      this.model,
      featurize(commitText(commit), signals, this.model.config ?? DEFAULT_FEATURE_CONFIG),
    );
    return {
      likelyDecision: p >= this.model.threshold,
      reason: `trained gate p=${p.toFixed(3)} (thr ${this.model.threshold})`,
      signals,
    };
  }
}
