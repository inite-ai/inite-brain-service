import type { CommitInput, DecisionClassifier, Layer1Verdict } from './types';
import type { TrainedDecisionClassifier } from './gate-classifier';

/**
 * The production Layer-1 gate: heuristic OR trained model.
 * (docs/code-memory/distillation-dataset.md)
 *
 * The heuristic is high-precision but low-recall — it needs a body / trailer /
 * rationale marker, so it misses reasons stated in the SUBJECT; the trained
 * model recovers those. On the frozen golden the union beats either alone while
 * keeping precision, so this is the default gate when a model is available. A
 * heuristic admit short-circuits (keeps its reason); otherwise the model decides.
 */
export class HybridDecisionClassifier implements DecisionClassifier {
  constructor(
    private readonly heuristic: DecisionClassifier,
    private readonly model: TrainedDecisionClassifier,
  ) {}

  classify(commit: CommitInput): Layer1Verdict {
    const h = this.heuristic.classify(commit);
    if (h.likelyDecision) return h;
    const m = this.model.classify(commit);
    return {
      likelyDecision: m.likelyDecision,
      reason: m.likelyDecision
        ? `model rescued (${m.reason})`
        : 'heuristic + model both reject',
      signals: h.signals,
    };
  }
}
