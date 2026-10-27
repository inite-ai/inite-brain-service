import type { Logger } from '@nestjs/common';
import type OpenAI from 'openai';
import type { SearchHit } from '../search/search.service';
import type { SynthesisGuardrails, SynthesizeDto } from './dto/synthesize.dto';
import { buildDecisionLog } from './decision-log';
import type { LaneId } from './answer-router';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { buildFactIndex } from './fact-index';
import type { FinalizeContext } from './answer-integrity';
import type { VerifierOutput } from './verifier';
import type { FocusSignalService } from './focus-signal.service';
import { resolveAdaptiveL3 } from './adaptive-gates';
import { buildL3DecisionCallback, type DecisionContext } from './decision-emit';
import type { AnswerCacheBeginResult } from '../answer-cache/answer-cache.service';
import type { MemoryDecisionService } from '../outcomes/memory-decision.service';
import type { L3EscalationService } from './l3-escalation.service';
import type { finalizeVerdict } from './verdict';
import type { SynthesizeResult } from './synthesize.types';
import type { Asker } from './asker';

/**
 * The L3 seam, out of synthesize.service.ts (file-size gate): the one
 * place a request escalates to raw sessions — after a verifier fail, and
 * (abstain-escalation) where memory would otherwise say it does not know.
 */
/**
 * The verdict of an answer that is not one: the generator's abstention,
 * the coverage floor, or an empty retrieval. It is where memory would say
 * it does not know — so it is exactly where the raw sessions get read
 * before it does. Measured on the production writes replayed on a stand:
 * the asOf question the document answered verbatim exited `no_results`
 * in 90 ms, before any raw text was consulted.
 */
export const UNANSWERED: VerifierOutput = {
  verdict: 'unsupported',
  unsupportedClaims: [],
  questionAnswered: false,
};

/** The evidence of an empty retrieval, for an L3 attempt that anchors on the raw text alone. */
export const NO_EVIDENCE: Pick<L3SeamArgs, 'results' | 'factIndex' | 'promptFactLines'> = {
  results: [],
  factIndex: new Map(),
  promptFactLines: [],
};

/**
 * Whether the cheaper tier — the search loop's refine round — has had its
 * turn: it ran, or the generator did not ask for it. L3 used to wait for a
 * refine even when none was coming, which kept it dark on every failure
 * whose round 1 asked for no second retrieval.
 */
export function refineSettled(p: {
  refined: boolean;
  generated: { refineQuery?: string | null };
}): boolean {
  return p.refined || !p.generated.refineQuery?.trim();
}

/** The generator's abstention sentinel — the exact string its prompt makes it return. */
export function isNoAnswer(answer: string): boolean {
  return answer.trim() === "I don't have grounded evidence for that.";
}

/** The part of an L3 attempt that is the same for every attempt of a request. */
export type L3Common = Omit<
  L3SeamArgs,
  'verdict' | 'refineAttempted' | 'results' | 'factIndex' | 'promptFactLines' | 'dateMathLines'
>;

export interface L3SeamDeps {
  l3?: L3EscalationService | undefined;
  focusSignal?: FocusSignalService | undefined;
  logger: Logger;
  decisions?: MemoryDecisionService | undefined;
  openai: OpenAI;
  finalize: (
    ctx: FinalizeContext,
    verdict: VerifierOutput,
    args: Omit<Parameters<typeof finalizeVerdict>[1], 'verdict' | 'questionAnswered'>,
  ) => Promise<SynthesizeResult>;
}

export interface L3SeamArgs {
  cache: AnswerCacheBeginResult | undefined;
  verdict: VerifierOutput;
  companyId: string;
  callerScopes: string[];
  dto: SynthesizeDto;
  profile: RetrievalProfile;
  lane: LaneId | null;
  model: string;
  answerLang: string | null;
  refineAttempted: boolean;
  results: SearchHit[];
  factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
  promptFactLines: string[];
  dateMathLines?: string[] | undefined;
  asker?: Asker | undefined;
  guardrails: SynthesisGuardrails;
  explain: boolean;
  decisionCtx: DecisionContext;
}

/**
 * G2 L3 escalation seam, extracted from synthesize() (function-size
 * budget). Returns the finalised L3 answer when the ladder fired AND
 * the re-verification flipped the verdict fail→pass; null otherwise
 * (the caller then takes the normal abstention exit). Monotone
 * single-shot ladder: the flow is linear so `escalated` is false at
 * this one call site and the tier cannot re-enter (the invariant is
 * enforced in l3TriggerDecision). A flipped answer is admitted to the
 * G1 cache exactly like any other supported grounded answer.
 */
export async function escalateToL3(
  deps: L3SeamDeps,
  args: L3SeamArgs,
): Promise<SynthesizeResult | null> {
  const { profile, companyId, decisionCtx } = args;
  if (!deps.l3 || !profile.l3Escalation) return null;
  const adaptiveL3 = await resolveAdaptiveL3(
    { focusSignal: deps.focusSignal, logger: deps.logger },
    args.companyId,
  );
  // 0119 decision capture: the service invokes the callback ONCE per
  // escalate() evaluation (an optional callback — the L3 engine dir
  // never reads env and never grows a MemoryDecisionService dep, S5.2).
  // Escalate() awaits before finalize, so a minted id is visible to the
  // L3-flip finalizeAndAdmit below via decisionCtx.
  const onDecision = buildL3DecisionCallback(deps.decisions, companyId, decisionCtx);
  const l3 = await deps.l3.escalate({
    openai: deps.openai,
    model: args.model,
    companyId: args.companyId,
    dto: args.dto,
    callerScopes: args.callerScopes,
    profile,
    lane: args.lane,
    verdict: args.verdict,
    refineAttempted: args.refineAttempted,
    escalated: false,
    results: args.results,
    factIndex: args.factIndex,
    factLines: args.promptFactLines,
    answerLang: args.answerLang,
    dateMathLines: args.dateMathLines,
    asker: args.asker,
    ...(adaptiveL3 ? { adaptiveL3 } : {}),
    ...(onDecision ? { onDecision } : {}),
  });
  if (!l3) return null;
  // What the answer read raw is learned in finalize (learnFromRaw), after
  // the gates, like every served answer that cites raw turns.
  // Route the L3 supported answer through the SAME answer-integrity gate as
  // the primary serve (Parts A + C) by carrying dto/profile/model into the
  // finalize context. The L3 answer grounds on the RAW TRANSCRIPT — the path
  // most exposed to belief distortion and to uncited "supported" answers — so
  // the gate MUST be end-to-end here. Both flags off ⇒ empty gate ⇒ the L3
  // serve is byte-identical to before (resolveAnswerIntegrity makes no LLM
  // call and returns {} when PLAUSIBILITY_CHECK is off, and REQUIRE_CITATIONS
  // off is a no-op). Cache-admit ordering is unchanged: gate → finalizeVerdict
  // → admit(final); a downgraded L3 abstain (reason=low_coverage, citations=[])
  // is rejected by admit()'s existing gate, so it is never cached.
  return deps.finalize(
    {
      cache: args.cache,
      dto: args.dto,
      profile: args.profile,
      model: args.model,
      companyId,
      decisionId: decisionCtx.primaryDecisionId,
    },
    l3.verdict,
    {
      answer: l3.answer,
      citations: l3.citations,
      // L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS): episode-level
      // refs for transcript-grounded claims — [] when the flag is off, so
      // finalizeVerdict never spreads the field. The primary serve path
      // passes nothing here.
      evidenceCitations: l3.evidenceCitations,
      results: args.results,
      guardrails: args.guardrails,
      decisionLog: args.explain
        ? buildDecisionLog(args.results, new Set(l3.citations.map((c) => c.factId)))
        : undefined,
      abstention: profile.abstentionCalibration,
    },
  );
}
