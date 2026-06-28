import type { CommitInput, DecisionClassifier, Layer1Verdict } from './types';
import {
  DECISION_TRAILER_KEYS,
  isMergeCommit,
  parseCommitSignals,
} from './commit-signals';

/**
 * Layer 1, deterministic. Admits commits whose message carries a plausible
 * engineering "why" and rejects pure noise — the cheap gate before the LLM
 * extractor runs. This is a stand-in for a trained classifier (CoMRAT-style
 * BiLSTM): it implements the exact {@link DecisionClassifier} seam, so a model
 * can replace it later without touching the pipeline, once a labeled commit
 * corpus exists. No LLM, no IO — safe to run over every commit.
 *
 * AVOIDs silent over-filtering: the verdict carries `reason` so a dropped
 * commit is auditable, never silently swallowed.
 */

// Types that are noise for DECISION capture when they carry no explanatory body.
const LOW_SIGNAL_TYPES = new Set(['chore', 'style', 'ci', 'build', 'test', 'docs']);
// Types that usually accompany a design change worth a "why".
const DECISION_TYPES = new Set(['feat', 'fix', 'refactor', 'perf', 'revert']);
// A body shorter than this with no other signal is treated as not worth an LLM call.
const MIN_EXPLANATORY_BODY = 80;

export class HeuristicDecisionClassifier implements DecisionClassifier {
  classify(commit: CommitInput): Layer1Verdict {
    const signals = parseCommitSignals(commit);

    if (isMergeCommit(commit)) {
      return { likelyDecision: false, reason: 'merge commit', signals };
    }

    const hasDecisionTrailer = DECISION_TRAILER_KEYS.some(
      (k) => k in signals.trailers,
    );
    if (hasDecisionTrailer) {
      return {
        likelyDecision: true,
        reason: 'explicit decision/rationale trailer',
        signals,
      };
    }

    const type = signals.conventionalType;
    const hasBody = signals.bodyLength >= MIN_EXPLANATORY_BODY;
    const hasRationale = signals.rationaleMarkers.length > 0;

    // Low-signal type with no explanatory body and no rationale prose → noise.
    if (type && LOW_SIGNAL_TYPES.has(type) && !hasBody && !hasRationale) {
      return {
        likelyDecision: false,
        reason: `low-signal type "${type}" with no explanatory body`,
        signals,
      };
    }

    if (hasRationale) {
      return {
        likelyDecision: true,
        reason: `rationale markers: ${signals.rationaleMarkers.join(', ')}`,
        signals,
      };
    }

    if (type && DECISION_TYPES.has(type) && hasBody) {
      return {
        likelyDecision: true,
        reason: `decision-type "${type}" with explanatory body`,
        signals,
      };
    }

    if (hasBody) {
      return {
        likelyDecision: true,
        reason: 'substantial explanatory body',
        signals,
      };
    }

    return {
      likelyDecision: false,
      reason: 'no decision trailer, rationale, or explanatory body',
      signals,
    };
  }
}
