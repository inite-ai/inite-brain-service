import { MemoryDecisionService } from '../outcomes/memory-decision.service';
import type { SearchHit } from '../search/search.service';
import type { LaneId } from './answer-router';
import type { AbstainAdaptiveGate } from './verdict';
import type { L3DecisionDraft } from './l3-escalation.service';
import { FRAGMENT_ZOOM_MAX_FRAGMENTS, type FragmentZoomResult } from './fragment-zoom';
import {
  buildFocusSignal,
  queryClassOf,
  rawFocusConfidence,
  type FocusSignal,
} from './focus-signal';

/**
 * Decision-context (0119) emit seams for the synthesize orchestrator,
 * extracted from the service (file/function budgets) — the outcome-emit
 * idiom. Every function is a guarded no-op unless the decision writer is
 * wired AND OUTCOME_DECISION_CAPTURE is on — checked through the service
 * STATIC so this engine dir takes resolved config only and never reads
 * the environment directly (engine-gates S5.2). The writer detaches its
 * insert (root pool, fire-and-forget, INSERT IGNORE on a deterministic
 * id), so serving never waits on decision telemetry and a telemetry
 * failure can never fail an answer.
 */

/**
 * Mutable per-request decision-capture context. `t0` anchors the
 * decision rows' costs.latencyMs; `primaryDecisionId` is set by
 * whichever decision writer fires FIRST in the flow (the abstain gate
 * evaluates pre-generation, the L3 trigger post-verifier) and is
 * threaded onto the outcome rows (emitAnswerUse) + the verdict-stage
 * focus sample. Stays empty unless OUTCOME_DECISION_CAPTURE is on.
 */
export interface DecisionContext {
  t0: number;
  primaryDecisionId?: string | undefined;
}

/**
 * The 'abstain' decision writer, called once per request where the
 * coverage-abstention gate was LIVE. observedState carries the SAME
 * buildFocusSignal numbers the adaptive gate computed (threaded via
 * resolveAdaptiveAbstain's `signal` — recomputed only on the static
 * path, where no gate ran); alternatives/actionScore exist only on the
 * adaptive path (the static floor is a rule, not a scored policy).
 * Claims the primary-decision slot when it is still free.
 */
export function captureAbstainDecision(
  decisions: MemoryDecisionService | undefined,
  companyId: string,
  args: {
    results: SearchHit[];
    lane: LaneId | null;
    adaptive?: (AbstainAdaptiveGate & { signal: FocusSignal }) | undefined;
    abstained: boolean;
    decisionCtx: DecisionContext;
  },
): void {
  if (!decisions || !MemoryDecisionService.enabled()) return;
  const factScores = args.results.flatMap((hit) => hit.facts.map((f) => f.score));
  const signal =
    args.adaptive?.signal ??
    buildFocusSignal({
      queryClass: queryClassOf(args.lane),
      factScores,
      verifierVerdict: 'none',
    });
  const id = decisions.record(companyId, {
    decisionKind: 'abstain',
    policyVersion: args.adaptive ? `adaptive@thr=${args.adaptive.threshold}` : 'static',
    chosenAction: args.abstained ? 'abstain' : 'proceed',
    ...(args.adaptive ? { actionScore: args.adaptive.confidence } : {}),
    observedState: {
      topScore: signal.topScore,
      coverageScore: signal.coverageScore,
      retrievalGap: signal.retrievalGap,
      rawConfidence: rawFocusConfidence(signal),
      candidateCount: factScores.length,
      queryClass: signal.queryClass,
    },
    ...(args.adaptive
      ? {
          alternatives: [
            { action: 'abstain', score: args.adaptive.threshold },
            { action: 'proceed', score: args.adaptive.confidence },
          ],
        }
      : {}),
    costs: { latencyMs: Date.now() - args.decisionCtx.t0 },
  });
  if (id !== undefined) args.decisionCtx.primaryDecisionId ??= id;
}

/**
 * Build the L3 onDecision callback (the service invokes it EXACTLY ONCE
 * per escalate() evaluation — L3EscalateInput.onDecision). Maps the
 * draft onto a memory_decision row: reason → chosenAction ('escalate' on
 * 'fire', else 'skip:<reason>'), the adaptive numbers → actionScore /
 * policyVersion / observedState, and maxSessions → candidateCount (the
 * ranked-session BUDGET at this seam — see the L3DecisionDraft
 * docblock). Undefined when capture is off / the writer is absent, so
 * the L3 input stays byte-identical.
 */
export function buildL3DecisionCallback(
  decisions: MemoryDecisionService | undefined,
  companyId: string,
  decisionCtx: DecisionContext,
): ((draft: L3DecisionDraft) => void) | undefined {
  if (!decisions || !MemoryDecisionService.enabled()) return undefined;
  return (draft: L3DecisionDraft) => {
    const id = decisions.record(companyId, {
      decisionKind: 'l3_escalation',
      policyVersion: draft.adaptive ? `adaptive@thr=${draft.adaptive.threshold}` : 'static',
      chosenAction: draft.reason === 'fire' ? 'escalate' : `skip:${draft.reason}`,
      ...(draft.adaptive ? { actionScore: draft.adaptive.confidence } : {}),
      observedState: {
        ...(draft.adaptive
          ? {
              topScore: draft.adaptive.topScore,
              coverageScore: draft.adaptive.coverageScore,
              retrievalGap: draft.adaptive.retrievalGap,
              queryClass: draft.adaptive.queryClass,
            }
          : {}),
        ...(draft.maxSessions !== undefined ? { candidateCount: draft.maxSessions } : {}),
      },
      costs: { latencyMs: Date.now() - decisionCtx.t0 },
    });
    if (id !== undefined) decisionCtx.primaryDecisionId ??= id;
  };
}

/**
 * The 'zoom' decision writer (FOVEA_FRAGMENT_ZOOM, MM-zoom PR3), called
 * once per EVALUATED zoom step — flag on and the primary verdict failed
 * (mirrors the metric: no row when the step never gated). chosenAction
 * carries the outcome directly ('zoom:flipped' / 'zoom:unchanged' /
 * 'skip:no_deeper' / 'error'); observedState.candidateCount is the
 * TRUNCATED-candidate count at this seam (the L3 maxSessions precedent:
 * candidateCount is the seam's budget-relevant count). Content-free by
 * the 0119 contract; claims the primary-decision slot when free.
 */
export function captureZoomDecision(
  decisions: MemoryDecisionService | undefined,
  companyId: string,
  args: { result: FragmentZoomResult; decisionCtx: DecisionContext },
): void {
  if (!decisions || !MemoryDecisionService.enabled()) return;
  const { result } = args;
  const chosenAction =
    result.outcome === 'flipped' || result.outcome === 'unchanged'
      ? `zoom:${result.outcome}`
      : result.outcome === 'skipped'
        ? 'skip:no_deeper'
        : 'error';
  const id = decisions.record(companyId, {
    decisionKind: 'zoom',
    policyVersion: `static@cap=${FRAGMENT_ZOOM_MAX_FRAGMENTS}`,
    chosenAction,
    observedState: { candidateCount: result.candidateCount },
    costs: { latencyMs: Date.now() - args.decisionCtx.t0 },
  });
  if (id !== undefined) args.decisionCtx.primaryDecisionId ??= id;
}
