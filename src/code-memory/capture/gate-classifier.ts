import type {
  CommitInput,
  DecisionClassifier,
  DecisionKind,
  Layer1Verdict,
} from './types';
import { parseCommitSignals } from './commit-signals';
import { commitText } from './silver-dataset';
import {
  DEFAULT_FEATURE_CONFIG,
  featurize,
  type FeatureConfig,
} from './gate-features';

/** The decision kinds the multi-label heads predict, in a stable order. */
export const GATE_KINDS: DecisionKind[] = [
  'decided',
  'because',
  'invariant',
  'gotcha',
];

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

/** One logistic-regression head: bias + sparse bucket→weight map. */
export interface LinearHead {
  bias: number;
  weights: Record<string, number>;
}

/** Serialised trained gate. `weights` is sparse (bucket index → weight); only
 *  buckets the trainer touched are stored. Portable JSON, no vocabulary.
 *  v2 adds optional per-kind one-vs-rest heads (multi-label). */
export interface GateModel {
  version: 1 | 2;
  config: FeatureConfig;
  /** Admit when P(decision) >= threshold. */
  threshold: number;
  bias: number;
  weights: Record<string, number>;
  /** Per-kind heads (v2). Absent on v1 models. */
  kinds?: Partial<Record<DecisionKind, LinearHead>>;
  /** Threshold for the per-kind heads (default 0.5). */
  kindThreshold?: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** Score a single linear head over a feature map. */
function scoreHead(head: LinearHead, feats: Map<number, number>): number {
  let z = head.bias;
  for (const [idx, val] of feats) {
    const w = head.weights[idx];
    if (w) z += w * val;
  }
  return sigmoid(z);
}

/** P(decision-bearing) for a feature map under a model (the binary gate head). */
export function predictProba(
  model: GateModel,
  feats: Map<number, number>,
): number {
  return scoreHead({ bias: model.bias, weights: model.weights }, feats);
}

/** P(kind) for each per-kind head the model carries. Empty for a v1 model. */
export function predictKindProbas(
  model: GateModel,
  feats: Map<number, number>,
): Partial<Record<DecisionKind, number>> {
  const out: Partial<Record<DecisionKind, number>> = {};
  for (const kind of GATE_KINDS) {
    const head = model.kinds?.[kind];
    if (head) out[kind] = scoreHead(head, feats);
  }
  return out;
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
      (m.version !== 1 && m.version !== 2) ||
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

  private features(commit: CommitInput): Map<number, number> {
    return featurize(
      commitText(commit),
      parseCommitSignals(commit),
      this.model.config ?? DEFAULT_FEATURE_CONFIG,
    );
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

  /** Per-kind probabilities (empty for a v1 model). */
  predictKinds(commit: CommitInput): Partial<Record<DecisionKind, number>> {
    return predictKindProbas(this.model, this.features(commit));
  }

  /** The decision kinds whose head clears the model's kind threshold. */
  classifyKinds(commit: CommitInput): DecisionKind[] {
    const thr = this.model.kindThreshold ?? 0.5;
    const probas = this.predictKinds(commit);
    return GATE_KINDS.filter((k) => (probas[k] ?? 0) >= thr);
  }
}
