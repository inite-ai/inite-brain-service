import { MemoryDecisionService } from '../outcomes/memory-decision.service';
import type { SearchHit } from '../search/search.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesizeResult } from './synthesize.types';
import { laneRouteCandidates, type LaneId } from './answer-router';
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
  /**
   * Terminal-verdict row inputs, stamped by synthesizeGrounded at the
   * point each becomes known, because the verdict writer fires OUTSIDE
   * it (synthesize(), so that every exit — including the cache hit and
   * the early no_results return — is covered by one seam).
   * `policy` is `<guardrails>/<abstentionCalibration>`, `queryClass` the
   * routed lane. Both absent ⇒ the row simply omits them.
   */
  policy?: string | undefined;
  queryClass?: string | undefined;
}

/**
 * The 'verdict' decision writer (0147) — one row per ANSWERED request,
 * recording what the request terminated on.
 *
 * This is the decision the plane was missing. 0119's writers (abstain,
 * l3_escalation) and the later zoom writer all sit behind flags that are
 * off in a default deployment, so with OUTCOME_DECISION_CAPTURE
 * default-on the table still took no rows at all — /stats answered
 * `sampled 0` against a live service. The terminal verdict always
 * happens, and its distribution (ok vs the declines) is the statistic
 * the read side exists to serve.
 *
 * Called from synthesize(), not synthesizeGrounded, so ONE seam covers
 * every non-throwing exit: the served answer, the early no_results
 * return, the coverage abstain, the grounding/capability declines, and
 * the answer-cache hit (which returns before retrieval — it has no lane,
 * and the absent queryClass is exactly how a cache serve reads).
 *
 * Does not claim the primary-decision slot: it fires after the outcome
 * rows have already been written with whatever policy decision explained
 * the answer.
 */
export function captureVerdictDecision(
  decisions: MemoryDecisionService | undefined,
  companyId: string,
  args: { result: SynthesizeResult; decisionCtx: DecisionContext },
): void {
  if (!decisions || !MemoryDecisionService.enabled()) return;
  const { result, decisionCtx } = args;
  let topScore = 0;
  let factCount = 0;
  for (const hit of result.results) {
    for (const f of hit.facts) {
      factCount += 1;
      if (typeof f.score === 'number' && f.score > topScore) topScore = f.score;
    }
  }
  decisions.record(companyId, {
    decisionKind: 'verdict',
    // The guardrails mode and the abstention mode ARE the policy at this
    // seam — a decline under 'strict'/'verifier' and the same decline
    // under 'lenient'/'off' are different decisions with the same name.
    policyVersion: decisionCtx.policy ? `verdict@${decisionCtx.policy}` : 'verdict',
    // `reason` is absent on the served path; 'ok' names it so byAction
    // reads as a distribution instead of a pile of declines beside a gap.
    chosenAction: result.reason ?? 'ok',
    observedState: {
      topScore,
      candidateCount: factCount,
      ...(decisionCtx.queryClass !== undefined ? { queryClass: decisionCtx.queryClass } : {}),
    },
    costs: { latencyMs: Date.now() - decisionCtx.t0 },
  });
}

/**
 * The 'lane_route' decision writer — the seam 0119 reserved and left
 * unwritten, called once per uncached request.
 *
 * It is the only decision on the read path that ALWAYS happens. The
 * abstain writer fires only under abstentionCalibration='coverage' and
 * the L3 writer only under RETRIEVAL_L3_ESCALATION; the zoom writer
 * needs FOVEA_FRAGMENT_ZOOM. All three are off by default, so a default
 * deployment with OUTCOME_DECISION_CAPTURE on wrote NOTHING — the read
 * side shipped with 0119 answered `[]` against a live, answering
 * service, and its /stats said `sampled 0` with the master flag on.
 *
 * Deliberately does NOT claim the primary-decision slot. The id
 * threaded onto the outcome rows has to stay the policy decision that
 * explains the ANSWER (abstain / L3 / zoom), and routing runs before
 * all of them — claiming it here would silently re-point every
 * memory_outcome.decisionId join at a row that says nothing about why
 * the answer came out the way it did.
 */
export function captureLaneRouteDecision(
  decisions: MemoryDecisionService | undefined,
  companyId: string,
  args: { profile: RetrievalProfile; query: string; lane: LaneId | null },
): void {
  if (!decisions || !MemoryDecisionService.enabled()) return;
  const { matched, routable } = laneRouteCandidates(args.profile, args.query);
  // resolveRoutedLane is lexical-first: the lexicon's own winner IS the
  // route unless the lexicon matched nothing and the multilingual
  // classifier (MULTILINGUAL_LANE_ROUTING) supplied one.
  const lexical = matched[0]?.lane ?? null;
  decisions.record(companyId, {
    decisionKind: 'lane_route',
    policyVersion: lexical === args.lane ? 'lexical' : 'classifier',
    chosenAction: args.lane ?? 'generic',
    observedState: {
      queryClass: queryClassOf(args.lane),
      // The size of the CHOICE set (routable lanes under this profile),
      // not of the match set — the lens governor subtracts lanes per
      // query class, so this number moves and the row must say so.
      candidateCount: routable,
    },
    // Registry order resolves ties, so precedence IS the score here —
    // normalized to keep the field's higher-is-better meaning, which a
    // raw rank index would read exactly backwards.
    alternatives: matched.map((m) => ({
      action: m.lane,
      score: routable > 0 ? 1 - m.precedence / routable : 1,
    })),
    // No costs: routing is a synchronous lexicon pass, so the only
    // number this seam could report is the time SOMETHING ELSE spent
    // before it — and the read side averages costs per kind, where that
    // would read as the cost of routing.
  });
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
