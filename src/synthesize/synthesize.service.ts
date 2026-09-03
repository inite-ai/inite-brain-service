import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SearchService, SearchHit } from '../search/search.service';
import { Semaphore } from '../common/semaphore';
import { withSpan } from '../common/tracing';
import { clampLlmInputText } from '../common/input-limits';
import { pinUserScope } from '../auth/user-scope';
import { MetricsService } from '../metrics/metrics.service';
import { SynthesisGuardrails, SynthesizeDto } from './dto/synthesize.dto';
import { buildDecisionLog } from './decision-log';
import { applyConformalGuardrail } from './conformal-guardrail';
import { coverageAbstention, finalizeVerdict } from './verdict';
import {
  attachDecisionLog,
  buildGeneratorArgs,
  buildSecondaryDto,
  enforceAnswerLanguage,
  resolveAnswerFrames,
  resolveAnswerLang,
  resolveCitations,
  resolveRoutedLane,
  serveCacheHit,
} from './synthesize.helpers';
import { applyEvidenceUnion } from './evidence-union';
import type { LaneId } from './answer-router';
import { runLaneProbe } from './lane-probe';
import { getActiveRetrievalProfile, type RetrievalProfile } from '../search/retrieval-profile';
import { buildFactIndex } from './fact-index';
import { fragmentCitationsEnabled } from '../common/evidence-flags';
import {
  beliefServingLaneEnabled,
  beliefLaneDateDisambiguationEnabled,
} from '../common/beliefs-flags';
import { resolveAndCountFragmentCitations } from './fragment-citations';
import { resolveAndCountBeliefCitations } from './belief-citations';
import { verifyAndZoom } from './fragment-zoom-seam';
import { FragmentLaneService } from './fragment-lane.service';
import { resolveAnswerIntegrity, type FinalizeContext } from './answer-integrity';
import { makeGroundingFetchPort } from './grounding-fetch';
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { SurrealService } from '../db/surreal.service';
import { applyFactSuffixes } from './update-story';
import { buildDateMathLines } from './date-math';
export { buildFactIndex } from './fact-index';
import { runGenerator, type GenerateRequest } from './generator-client';
import type { VerifierOutput } from './verifier';
export { buildGeneratorUserMessage } from './generator-prompt';
import {
  EvidenceCollectorService,
  emptyCollectedEvidence,
  type CollectedEvidence,
} from './evidence-collector.service';
import { L3EscalationService } from './l3-escalation.service';
import { FocusSignalService } from './focus-signal.service';
import type { FocusVerdict } from './focus-signal';
import { resolveAdaptiveAbstain, resolveAdaptiveL3 } from './adaptive-gates';
import {
  buildL3DecisionCallback,
  captureAbstainDecision,
  type DecisionContext,
} from './decision-emit';
import { LensSuppressionService } from './lens-suppression.service';
import { MultilingualLaneClassifierService } from './multilingual-lane-classifier.service';
import {
  AnswerCacheService,
  type AnswerCacheBeginResult,
} from '../answer-cache/answer-cache.service';
import { MemoryOutcomeService } from '../outcomes/memory-outcome.service';
import { MemoryDecisionService } from '../outcomes/memory-decision.service';
import {
  emitAnswerUse,
  emitBeliefAnswerUse,
  emitBeliefContext,
  emitSelectedForContext,
  unverifiedServe,
} from './outcome-emit';
import { NOOP_REPORTER, type ProgressReporter } from '../mcp/progress-reporter';

export interface SynthesizeOptions {
  companyId: string;
  dto: SynthesizeDto;
  callerScopes: string[];
  onProgress?: ProgressReporter;
  /**
   * The per-tenant retrieval profile resolved by the guard. Optional so
   * background callers fall back to the request-context / boot default.
   */
  profile?: RetrievalProfile;
  /**
   * Pre-retrieved evidence merged into the re-search results before the
   * generator sees them (multi-hop passes its hop hits here). Base
   * results keep their order;
   * unseen extra facts append best-score-first, capped by
   * SYNTHESIZE_EXTRA_EVIDENCE_CAP.
   */
  extraHits?: SearchHit[];
}

export type { Citation } from './fact-index';
// The result/IO types live in synthesize.types.ts (so pure helpers
// never type-import back into this service); re-exported here for the
// existing consumers (multi-hop, MCP surfaces).
export type {
  GeneratorOutput,
  SynthesisReason,
  SynthesizeResult,
  TokenUsage,
} from './synthesize.types';
import type { GeneratorOutput, SynthesizeResult } from './synthesize.types';

/**
 * SynthesizeService — orchestrates the corrective-RAG flow:
 *
 *   search → generate → verify → return
 *
 * Each LLM call runs under its own OTel span; metrics emit one
 * outcome per request via brain_synthesize_total{outcome}. The
 * service is request-scoped — no per-tenant state.
 *
 * Failure modes are explicit. "I don't know" is the default for
 * empty results, generator errors, and verifier failures in strict
 * mode. The caller never sees a generated answer that wasn't
 * grounded in the retrieved set (in strict mode).
 */
@Injectable()
export class SynthesizeService {
  private readonly logger = new Logger(SynthesizeService.name);
  private readonly openai: OpenAI;
  private readonly defaultModel: string;
  private readonly limiter: Semaphore;
  private readonly defaultGuardrails: SynthesisGuardrails;
  private readonly minCalibratedConfidence: number;
  private readonly minFactTrust: number;
  private readonly minicheckUrl: string;
  private readonly minicheckModel: string;

  // The typed prompt sections (transcript / insights / instructions)
  // come from ONE collector behind one contract (V9 quality pass — the
  // orchestrator was accreting a lane service per evidence class: 7
  // ctor params before, 4 now); optional so positionally-constructed
  // unit tests stay as-is.
  // eslint-disable-next-line max-params
  constructor(
    private readonly search: SearchService,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly evidenceCollector?: EvidenceCollectorService,
    @Optional() private readonly answerCache?: AnswerCacheService,
    @Optional() private readonly l3?: L3EscalationService,
    @Optional() private readonly focusSignal?: FocusSignalService,
    @Optional() private readonly lensSuppression?: LensSuppressionService,
    @Optional() private readonly laneClassifier?: MultilingualLaneClassifierService,
    // 0107 outcome writer — @Optional so positional unit fixtures stay valid.
    @Optional() private readonly outcomes?: MemoryOutcomeService,
    // 0113 evidence-capability gate: per-predicate policy source (AiModule
    // is @Global, so this resolves in every app composition). @Optional so
    // positional unit fixtures stay valid — absent ⇒ the resolver no-ops.
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
    // 0115 ungrounded-support gate: grounding fetch source (grounding-fetch.ts).
    @Optional() private readonly surreal?: SurrealService,
    // 0119 decision-context writer — @Optional so positional unit
    // fixtures stay valid; absent (or flag off) ⇒ no decision rows, no
    // join columns, byte-identical serving.
    @Optional() private readonly decisions?: MemoryDecisionService,
    // MM-zoom PR3 (FOVEA_FRAGMENT_ZOOM): the fenced fuller-text read for
    // the zoom step. @Optional so positional unit fixtures stay valid —
    // absent ⇒ the zoom seam no-ops (static behavior).
    @Optional() private readonly fragmentLane?: FragmentLaneService,
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.defaultModel = this.configService.get<string>(
      'SYNTHESIZE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(this.configService.get<string>('SYNTHESIZE_CONCURRENCY', '4'), 10),
    );
    const raw = this.configService.get<string>('SYNTHESIZE_DEFAULT_GUARDRAILS', 'strict');
    this.defaultGuardrails =
      raw === 'lenient' || raw === 'off' || raw === 'answer' ? raw : 'strict';
    // ConU conformal guardrail floor. Pre-fix the default was 0 (off);
    // the audit found prod also never set the env, so the guardrail
    // short-circuited at applyConformalGuardrail():53 and the Phase 3.C
    // claim was unfulfilled. The default is now 0.30 — equivalent to
    // the bitemporal RESOLVER reject_threshold so a fact admitted as a
    // valid INSERTED by the conflict resolver is also admitted as a
    // valid synthesize citation. Operators can disable per-deployment
    // by setting SYNTHESIZE_MIN_CONFIDENCE=0.
    this.minCalibratedConfidence = parseFloat(
      this.configService.get<string>('SYNTHESIZE_MIN_CONFIDENCE', '0.30'),
    );
    // Source-reputation Phase 5: citation floor on the write-time source
    // reputation (factTrust.sourceReputation). Default 0 = off; facts
    // without a snapshot sit on the neutral 0.5, so floors ≤ 0.5 only
    // ever drop facts whose source has genuinely EARNED distrust.
    this.minFactTrust = parseFloat(
      this.configService.get<string>('SYNTHESIZE_MIN_FACT_TRUST', '0'),
    );
    // V11 §2 arm (b): local NLI endpoint for abstention='minicheck'.
    this.minicheckUrl = this.configService.get<string>('MINICHECK_URL', 'http://127.0.0.1:11434');
    this.minicheckModel = this.configService.get<string>('MINICHECK_MODEL', 'bespoke-minicheck');
  }

  /**
   * Public entry — the grounded flow plus the ONE flag-free change of
   * the 0119 wave: a synthesize-boundary latency observe. The
   * brain_search_duration_seconds histogram was defined but never
   * observed on the serving path, so the MRI latency cells rendered
   * `pending` forever (audit pt-8). A prom histogram observe() has no
   * serving-path branch and alters no response bytes — metrics-only,
   * zero behavioral effect — and the `finally` guarantees EXACTLY ONE
   * observation per request, including error/abstain/cache-hit exits.
   */
  async synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
    const t0 = Date.now();
    try {
      return await this.synthesizeGrounded(opts, { t0 });
    } finally {
      this.metrics?.observeSearchDuration((Date.now() - t0) / 1000);
    }
  }

  private async synthesizeGrounded(
    {
      companyId,
      dto,
      callerScopes,
      onProgress = NOOP_REPORTER,
      extraHits,
      profile = getActiveRetrievalProfile(),
    }: SynthesizeOptions,
    decisionCtx: DecisionContext,
  ): Promise<SynthesizeResult> {
    // Defence-in-depth clamp. SynthesizeDto.@MaxLength('query', 8000)
    // covers HTTP callers, but multi-hop and admin-demo drive
    // synthesize() with bodies that bypass class-validator. Clamp here
    // so the generator prompt size is bounded regardless of caller.
    const clamped = clampLlmInputText(dto.query ?? '', 'query');
    if (clamped.truncated) {
      this.logger.warn(
        `synthesize: query truncated to ${clamped.value.length} chars (companyId=${companyId})`,
      );
    }
    // One user-scope pin for the WHOLE request (audit 2026-08-13 P1-4):
    // search() re-pins its own clone only — the collector lanes read
    // dto.userId directly and got tenant-global-only evidence without it.
    dto = { ...dto, query: clamped.value, userId: pinUserScope(dto.userId) };
    const guardrails: SynthesisGuardrails = dto.synthesisGuardrails ?? this.defaultGuardrails;
    const model = dto.synthesisModel ?? this.defaultModel;
    const explain = dto.explain === true;

    // Optics §4.3 lens-suppression governor: rebind `profile` to the EFFECTIVE
    // profile — off-task / trap-inducing lanes SUBTRACTED for this query's
    // learned class (never added, never reordered) — so EVERY downstream seam
    // (routeLane, evidence collector, detectEvidenceConflicts, markRecency, L3,
    // abstention) sees the reduced set. BEFORE the answer cache begins, so the
    // cache key (profileHash includes profile.lanes) reflects the effective
    // lanes. Flag off / deps absent / no-model / low-confidence → the SAME
    // profile object (byte-identical, same cache key). See LensSuppressionService.
    profile = (await this.lensSuppression?.effectiveProfile(companyId, profile, dto)) ?? profile;

    // G1 answer cache (SYNTHESIZE_ANSWER_CACHE): exact-key serve with
    // check-on-read fact-lifecycle gating, BEFORE retrieval; a miss
    // carries the key context to the admit hook (finalizeAndAdmit).
    const cacheArgs = { companyId, dto, callerScopes, profile, model, guardrails };
    const cache = await this.answerCache?.begin(cacheArgs);
    // A served cache hit is a terminal `ok` (admit() only caches supported+cited);
    // count it so the MRI per-request denominator includes cache hits (R3 P1).
    if (cache?.hit) return serveCacheHit(this.metrics, cache.hit);

    // Typed dispatch: lane detection is lexical and free, so it runs
    // before retrieval — the preference lane adds a deterministic
    // second probe that similarity search would never surface. Multilingual
    // Tier 4: a null regex route is augmented by the language-agnostic
    // classifier when MULTILINGUAL_LANE_ROUTING is on (abstain-safe, off =
    // byte-identical). See resolveRoutedLane.
    const lane: LaneId | null = await resolveRoutedLane(profile, dto.query, this.laneClassifier);

    onProgress({ stage: 'search', message: 'hybrid retrieval' });
    const searchResult = await withSpan(
      'synthesize.search',
      () => this.search.search(companyId, dto, callerScopes),
      { 'synthesize.guardrails': guardrails },
    );
    const laneProbeHits = await runLaneProbe(
      { search: this.search, logger: this.logger },
      { profile, lane, dto, companyId, callerScopes, baseHits: searchResult.results },
    );
    // Conformal guardrail: drop facts below the calibrated-confidence floor
    // (default SYNTHESIZE_MIN_CONFIDENCE=0.30) BEFORE the generator sees them
    // as citation targets. Facts still appear in the DecisionLog (with the
    // `low_score` reject reason) when the caller asked for `explain: true`.
    //
    // In 'answer' (never-abstain) mode the floor is disabled: the whole point
    // of that mode is to commit to a best-effort answer, so silently dropping
    // low-confidence facts here — which can empty `results` and force the
    // `no_results` null return below — would defeat it. That was a real
    // cross-knob trap: 'answer' callers otherwise had to ALSO set
    // SYNTHESIZE_MIN_CONFIDENCE=0 to actually never abstain.
    // Evidence union (Phase A): fold the caller's pre-retrieved hits in
    // BEFORE the guardrail so extra facts face the same floors. Base
    // results stay first; unseen extras append best-score-first, capped.
    const evidence = applyEvidenceUnion(
      searchResult.results,
      laneProbeHits.length > 0 ? [...(extraHits ?? []), ...laneProbeHits] : extraHits,
      profile.extraEvidenceCap,
    );

    const prepareOpts = this.buildPrepareOpts({
      answerMode: guardrails === 'answer',
      explain,
      lane,
      asOf: dto.asOf,
      profile,
    });
    const prepared = this.prepareEvidence(evidence, prepareOpts);
    if ('empty' in prepared) return prepared.empty;
    // `let`: the V13 search loop may replace the evidence set with the
    // refined round's union before citations resolve.
    let { results, factIndex } = prepared;

    // V9 §4 coverage abstention + Optics §4.2 pre-answer capture/gate (seam).
    const abstained = await this.maybeCoverageAbstain(
      companyId,
      { lane, query: dto.query, decisionCtx },
      { profile, guardrails, results, explain },
    );
    if (abstained) return abstained;

    // Every non-fact prompt section — transcript quotes, insights,
    // standing instructions — comes from the collector behind one
    // contract (V9 quality pass; all lanes concurrent inside). Running
    // it AFTER the empty/abstention exits also stops the pre-V9 waste
    // of an abandoned in-flight instruction probe on those paths.
    const collected = await this.collectSections({
      profile,
      lane,
      companyId,
      dto,
      callerScopes,
      factIds: [...factIndex.keys()],
      evidence,
    });
    // The other rendered sections stay on `collected` — the verify stage
    // (verifyAndZoom) and produceAnswer read them from there directly.
    const { fragmentsById, beliefsById, updateStories, groundingQuotes } = collected;
    // 0107 belief arm (D7): the rendered belief lines were selected for
    // context — final here (the refine round never re-runs the lane).
    emitBeliefContext(this.outcomes, companyId, beliefsById?.keys() ?? []);

    // V10 §2 update stories + multiworld §10 grounding quotes: both
    // suffix maps land on the SAME lines the generator and the
    // verifier read (prompt-side only; citations and ranking
    // untouched).
    let promptFactLines = applyFactSuffixes(prepared.factLines, [updateStories, groundingQuotes]);

    // V13 answer-side frames, both profile-gated and both pure:
    // the computed date table (generator and verifier read the same
    // lines — evidence parity) and the G2 per-shape reading frame.
    const frames = resolveAnswerFrames({ profile, query: dto.query, results });
    const shapeInstruction = frames.shapeInstruction;
    let dateMathLines = frames.dateMathLines;

    // Phase 4.C answer language; Tier 5 (profile.answerLangGuard) applies the
    // strict fallback order so the facts never decide it (off ⇒ byte-identical).
    const answerLang = resolveAnswerLang(dto, profile);

    onProgress({ stage: 'generate', message: `LLM grounding answer over ${factIndex.size} facts` });
    // Generation + the V13 constrained refine round, one seam: a
    // 'failed' result is the generator_error early-return; otherwise
    // the tuple is whichever round answered last.
    const produced = await this.produceAnswer({
      companyId,
      callerScopes,
      dto,
      profile,
      lane,
      model,
      answerLang,
      guardrails,
      explain,
      evidence,
      prepareOpts,
      updateStories,
      groundingQuotes,
      results,
      factIndex,
      promptFactLines,
      dateMathLines,
      shapeInstruction,
      collected: {
        ...collected,
        // MM-zoom PR2: citation affordance (populated fence map ⟺
        // switch on AND rendered); round 2 carries both.
        fragmentCitations: fragmentsById !== undefined,
        // BELIEFS_SERVING_LANE: same construction — citations ride the
        // master flag, so affordance ⟺ the lane rendered anything.
        beliefCitations: beliefsById !== undefined,
      },
    });
    if ('failed' in produced) return produced.failed;
    const { generated } = produced;
    ({ results, factIndex, promptFactLines, dateMathLines } = produced);

    const citations = resolveCitations(generated.citedFactIds, generated.answer, factIndex);
    const citedSet = new Set(citations.map((c) => c.factId));
    const decisionLog = explain ? buildDecisionLog(results, citedSet) : undefined;

    const unverified = unverifiedServe(
      { metrics: this.metrics, outcomes: this.outcomes },
      companyId,
      { guardrails, generated, citations, results, decisionLog },
    );
    if (unverified) return unverified;

    onProgress({ stage: 'verify', message: 'verifier checking claim grounding' });
    // Verifier — the corrective guardrail — plus the MM-zoom PR3
    // fragment-zoom step (FOVEA_FRAGMENT_ZOOM), ONE stage behind one
    // seam (fragment-zoom-seam.ts, moved whole for the size gates: the
    // primary audit and the zoom re-verify build their VerifyRequest in
    // one module, so evidence parity between them holds by
    // construction). Strict gates the answer behind a 'supported'
    // verdict; lenient surfaces the verdict but returns the answer
    // either way; 'minicheck' delegates to the local NLI. A verifier
    // throw returns the historical verifier_error result. On a
    // zoom flip the returned verdict is the RE-verified one — the L3
    // trigger below then reads 'skip_verdict_ok' and the normal
    // supported serve runs; otherwise (and always with the flag off)
    // it is the primary verdict, byte for byte.
    //
    // Optics-1 focus capture rides the onPrimaryVerdict callback so the
    // sample sees the PRE-zoom verdict (fit-shape discipline; see
    // maybeCaptureFocusSignal — SERVING-NEUTRAL guarded no-op).
    // `dto.query` carries the Tier 5 language key onto the verdict
    // sample; the 0119 primary decision id joins sample → decision row.
    const verified = await verifyAndZoom(this.verifyDeps(), {
      ctx: cacheArgs,
      generated,
      collected,
      promptFactLines,
      dateMathLines,
      citations,
      results,
      decisionLog,
      factCount: factIndex.size,
      decisionCtx,
      onPrimaryVerdict: (v) =>
        this.maybeCaptureFocusSignal(
          companyId,
          { results, verdict: v.verdict, lane, decisionId: decisionCtx.primaryDecisionId },
          dto.query,
        ),
    });
    if ('failed' in verified) return verified.failed;
    const { verdict } = verified;

    // G2 L3 escalation — the pre-abstention seam. On a verifier-fail with
    // an anchoring session it escalates ONCE to full-raw-session context
    // and returns the L3 answer when re-verification flips fail→pass;
    // else (null) the normal abstention/decline exit runs. Trigger matrix
    // + anchor requirement live in tryL3Escalation / the L3 service.
    // BOTH exits resolve the default-off verifier answer-integrity arm (Parts
    // A + C): on no-flip the primary finalizeAndAdmit runs it, and the L3 flip
    // path runs it too (its raw-transcript answer is the most exposed, so the
    // gate is end-to-end).
    const escalated = await this.tryL3Escalation({
      cache,
      verdict,
      companyId,
      callerScopes,
      dto,
      profile,
      lane,
      model,
      answerLang,
      refineAttempted: produced.refined,
      results,
      factIndex,
      promptFactLines,
      dateMathLines,
      guardrails,
      explain,
      decisionCtx,
    });
    if (escalated) return escalated;
    // decisionId read AFTER the L3 evaluation: a skip/no-flip escalation
    // still minted its decision row, and the primary serve joins to it.
    const decisionId = decisionCtx.primaryDecisionId;
    return this.finalizeAndAdmit({ cache, dto, profile, model, companyId, decisionId }, verdict, {
      answer: generated.answer,
      citations,
      results,
      guardrails,
      decisionLog,
      abstention: profile.abstentionCalibration,
      // MM-zoom PR2 + BELIEFS_SERVING_LANE: fragment-arm and belief-arm
      // evidence citations through their rendered-set fences, merged —
      // spread onto the served result only when non-empty
      // (finalizeVerdict) and fed to the 0113 capability gate
      // (citedCapabilities; the belief arm carries no capability stamp).
      // [] with both flags off ⇒ byte-identical.
      evidenceCitations: [
        ...resolveAndCountFragmentCitations({
          citedFragmentIds: generated.citedFragmentIds,
          fragmentsById,
          metrics: this.metrics,
        }),
        ...resolveAndCountBeliefCitations({
          citedBeliefIds: generated.citedBeliefIds,
          beliefsById,
          metrics: this.metrics,
        }),
      ],
    });
  }

  /**
   * Every non-fact prompt section behind one seam (extracted from
   * synthesize() for the function-size gate): the collector when wired,
   * else the empty fallback. The instruction probe inside inherits the
   * caller's filter contract via `dto` (audit 2026-08-19 P1), and the
   * lanes read the same fail-closed user scope as the fact path (0055).
   * EVIDENCE_FRAGMENT_CITATIONS is resolved ONCE here (the L3
   * single-resolution idiom): the rendered headers, the generator
   * schema/affordance, and the resolver all key off the resulting
   * fence map (populated ⟺ switch on AND fragments rendered).
   */
  private async collectSections(opts: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    companyId: string;
    dto: SynthesizeDto;
    callerScopes: string[];
    factIds: string[];
    evidence: SearchHit[];
  }): Promise<CollectedEvidence> {
    if (!this.evidenceCollector) return emptyCollectedEvidence(opts.profile, opts.dto.query);
    return this.evidenceCollector.collect({
      profile: opts.profile,
      lane: opts.lane,
      companyId: opts.companyId,
      query: opts.dto.query,
      callerScopes: opts.callerScopes,
      userId: opts.dto.userId,
      dto: opts.dto,
      factIds: opts.factIds,
      evidence: opts.evidence,
      fragmentCitations: fragmentCitationsEnabled(),
      // BELIEFS_SERVING_LANE, resolved ONCE per request (the same
      // single-resolution idiom): the lane, the rendered headers, the
      // generator affordance and the resolver all key off the resulting
      // fence map (populated ⟺ flag on AND beliefs rendered).
      beliefLane: beliefServingLaneEnabled(),
      // BELIEFS_LANE_DATE_DISAMBIGUATION, resolved ONCE beside the lane
      // flag: the lane's rendered date token and the generator's belief
      // header key off the same resolution (echoed on CollectedEvidence).
      beliefDateDisambiguation: beliefLaneDateDisambiguationEnabled(),
    });
  }

  /**
   * Optics-1 focus-signal capture — a guarded no-op when the flag is off
   * (or the service is absent). Extracted so synthesize() keeps a single
   * capture call on the serving path and stays within its line budget.
   * SERVING-NEUTRAL: nothing consumes the captured signal yet.
   */
  private async maybeCaptureFocusSignal(
    companyId: string,
    signal: {
      results: SearchHit[];
      verdict: FocusVerdict;
      lane: LaneId | null;
      /** 0119 join key — present only under OUTCOME_DECISION_CAPTURE. */
      decisionId?: string | undefined;
    },
    query: string,
  ): Promise<void> {
    if (!this.focusSignal || !FocusSignalService.captureEnabled()) return;
    await this.focusSignal.maybeCapture(companyId, { ...signal, query });
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
  private async tryL3Escalation(args: {
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
    guardrails: SynthesisGuardrails;
    explain: boolean;
    decisionCtx: DecisionContext;
  }): Promise<SynthesizeResult | null> {
    const { profile, companyId, decisionCtx } = args;
    if (!this.l3 || !profile.l3Escalation) return null;
    const adaptiveL3 = await resolveAdaptiveL3(
      { focusSignal: this.focusSignal, logger: this.logger },
      args.companyId,
    );
    // 0119 decision capture: the service invokes the callback ONCE per
    // escalate() evaluation (an optional callback — the L3 engine dir
    // never reads env and never grows a MemoryDecisionService dep, S5.2).
    // Escalate() awaits before finalize, so a minted id is visible to the
    // L3-flip finalizeAndAdmit below via decisionCtx.
    const onDecision = buildL3DecisionCallback(this.decisions, companyId, decisionCtx);
    const l3 = await this.l3.escalate({
      openai: this.openai,
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
      ...(adaptiveL3 ? { adaptiveL3 } : {}),
      ...(onDecision ? { onDecision } : {}),
    });
    if (!l3) return null;
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
    return this.finalizeAndAdmit(
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

  /** The verify-stage ports, bundled once (fragment-zoom-seam.ts owns
   *  the primary audit + the MM-zoom PR3 step; this service only lends
   *  its ports — the resolveAnswerIntegrity deps idiom). */
  private verifyDeps() {
    return {
      openai: this.openai,
      metrics: this.metrics,
      logger: this.logger,
      limiter: this.limiter,
      fragmentLane: this.fragmentLane,
      decisions: this.decisions,
      minicheck: { baseUrl: this.minicheckUrl, model: this.minicheckModel },
    };
  }

  /**
   * Verdict exit + G1 write-through admission, one seam. Only a
   * verifier-supported grounded answer reaches the cache — admit() re-checks
   * verdict/answer/reason/citations and no-ops otherwise, so abstentions,
   * unverified returns, low_coverage and partial verdicts are never cached.
   *
   * `ctx.dto`+`ctx.profile` are supplied by BOTH serving paths — the primary
   * serve AND the L3 flip — so both resolve the default-off verifier
   * answer-integrity arm (Parts A + C — answer-integrity.ts) over the supported
   * verdict and merge the gate flags into finalizeVerdict. BOTH flags off ⇒
   * empty gate ⇒ byte-identical serve on either path (no LLM call, no flag
   * effect). A gate downgrade produces a low_coverage/zero-citation result that
   * admit() rejects, so a downgraded answer is never cached. The auditor model
   * (profile.verifierModel || synthesis model) is resolved here so the caller
   * carries no branch.
   */
  private async finalizeAndAdmit(
    ctx: FinalizeContext,
    verdict: VerifierOutput,
    args: Omit<Parameters<typeof finalizeVerdict>[1], 'verdict' | 'questionAnswered'>,
  ): Promise<SynthesizeResult> {
    // 0107: cited facts were USED; a supported verdict ⇒ VERIFIED use.
    // Both serving paths (primary + L3 flip) land here with companyId;
    // the 0119 primary decision id (capture on) joins outcome → decision.
    emitAnswerUse(this.outcomes, {
      companyId: ctx.companyId,
      citations: args.citations,
      verdict,
      decisionId: ctx.decisionId,
    });
    // 0107 belief arm (D7): cited beliefs count as use — and as VERIFIED
    // use on a supported verdict — with the same decisionId threading.
    emitBeliefAnswerUse(this.outcomes, {
      companyId: ctx.companyId,
      evidenceCitations: args.evidenceCitations,
      verdict,
      decisionId: ctx.decisionId,
    });
    // The gate-resolution also folds in the evidence-capability flag
    // (FOVEA_EVIDENCE_CAPABILITY, 0113 — resolveEvidenceCapability, the
    // resolveAnswerIntegrity sibling in answer-integrity.ts): does the
    // supported answer's cited predicate set REQUIRE non-text evidence no
    // citation carries? Flag off / no registry ⇒ absent ⇒ byte-identical.
    const fetchGrounding = makeGroundingFetchPort(this.surreal);
    const registry = this.predicateRegistry;
    const gate = await resolveAnswerIntegrity(
      { openai: this.openai, metrics: this.metrics, logger: this.logger, limiter: this.limiter },
      { ctx, verdict, args, defaultModel: this.defaultModel, registry, fetchGrounding },
    );
    const final = this.finalizeVerdict({
      verdict: verdict.verdict,
      questionAnswered: verdict.questionAnswered,
      ...args,
      ...gate,
    });
    if (ctx.cache?.ctx) {
      await this.answerCache?.admit(ctx.cache.ctx, final, verdict.verdict);
    }
    return final;
  }

  /**
   * Round-1 generation plus the V13 refine round behind one seam
   * (extracted from synthesize() for the function-size gates). A
   * generator failure returns `{failed}` — the historical
   * generator_error early-exit, decision log included; otherwise the
   * returned tuple is round 2 when it ran, round 1 when it did not.
   */
  private async produceAnswer(
    args: Omit<Parameters<SynthesizeService['refineRound']>[0], 'generated'> & {
      explain: boolean;
      results: SearchHit[];
      factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
      promptFactLines: string[];
      dateMathLines?: string[] | undefined;
    },
  ): Promise<
    | { failed: SynthesizeResult }
    | {
        results: SearchHit[];
        factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
        promptFactLines: string[];
        dateMathLines?: string[] | undefined;
        generated: GeneratorOutput;
        /** Whether the one search-loop refine round actually ran (the
         *  G2 L3 trigger requires a refine to precede escalation when
         *  the search loop is on). */
        refined: boolean;
      }
  > {
    const { profile } = args;
    let generated: GeneratorOutput;
    try {
      generated = await withSpan(
        'synthesize.generate',
        () =>
          this.limiter.run(() =>
            this.callGenerator(
              // Round 1 exposes the V13 refine affordance (allowRefine).
              buildGeneratorArgs(args, {
                results: args.results,
                promptFactLines: args.promptFactLines,
                dateMathLines: args.dateMathLines,
                allowRefine: profile.searchLoop,
              }),
            ),
          ),
        { 'synthesize.facts': args.factIndex.size },
      );
    } catch (err) {
      this.logger.warn(`Synthesize generator failed: ${(err as Error).message}`);
      this.metrics?.countSynthesize('generator_error');
      return {
        failed: attachDecisionLog(
          {
            answer: null,
            reason: 'generator_error',
            citations: [],
            results: args.results,
          },
          args.explain ? buildDecisionLog(args.results, new Set()) : undefined,
        ),
      };
    }
    const second = await this.refineRound({ ...args, generated });
    const round = second
      ? { ...second, refined: true }
      : {
          results: args.results,
          factIndex: args.factIndex,
          promptFactLines: args.promptFactLines,
          dateMathLines: args.dateMathLines,
          generated,
          refined: false,
        };
    // 0107: the FINAL evidence set (post-refine) was selected for
    // context — once per request, at the point the set is final.
    emitSelectedForContext(this.outcomes, args.companyId, round.factIndex.keys());
    // Tier 5 answer-language guard — no-op unless on AND the final answer's
    // language mismatches; then the corrected regeneration replaces `generated`.
    const corrected = await enforceAnswerLanguage(
      { metrics: this.metrics, logger: this.logger },
      { guard: profile.answerLangGuard, target: args.answerLang, answer: round.generated.answer },
      () =>
        withSpan('synthesize.generate_lang_retry', () =>
          this.limiter.run(() =>
            this.callGenerator(
              buildGeneratorArgs(args, {
                results: round.results,
                promptFactLines: round.promptFactLines,
                dateMathLines: round.dateMathLines,
                answerLangStrict: true,
              }),
            ),
          ),
        ),
    );
    return corrected ? { ...round, generated: corrected } : round;
  }

  /**
   * V13 constrained search loop — the ONE refine round. Eligibility
   * gate first (flag on, a usable refined query, not the original
   * query verbatim), then a second retrieval union-merged over the
   * round-1 evidence and a forced-answer generation (the round-2 call
   * carries no refine affordance — the cap is structural). Null on
   * ineligibility or any failure — the caller keeps the round-1
   * answer; the loop can only add evidence, never lose an answer.
   */
  private async refineRound(args: {
    companyId: string;
    callerScopes: string[];
    dto: SynthesizeDto;
    profile: RetrievalProfile;
    lane: LaneId | null;
    model: string;
    answerLang: string | null;
    guardrails: SynthesisGuardrails;
    generated: GeneratorOutput;
    evidence: SearchHit[];
    prepareOpts: Parameters<SynthesizeService['prepareEvidence']>[1];
    updateStories?: Map<string, string> | undefined;
    /** Multiworld §10 facts-as-keys: quotes for the ROUND-1 top facts —
     *  refined-in facts stand without quotes (unmatched lines pass). */
    groundingQuotes?: Map<string, string> | undefined;
    shapeInstruction?: string | undefined;
    collected: {
      transcriptLines: string[];
      insightLines: string[];
      instructions?: string[] | undefined;
      timelineEvidence: boolean;
      /** G4 advisory notes — generator-only (parity exception). */
      strategyNotes?: string[] | undefined;
      /** MM-zoom PR2: media lines + citation affordance — round 2
       *  carries them identically (buildGeneratorArgs reads both). */
      fragmentLines?: string[] | undefined;
      fragmentCitations?: boolean | undefined;
      /** BELIEFS_SERVING_LANE: belief lines + affordance — round 2
       *  carries them identically too. */
      beliefLines?: string[] | undefined;
      beliefCitations?: boolean | undefined;
      /** BELIEFS_LANE_DATE_DISAMBIGUATION echo — the belief-section
       *  header rides the same per-request resolution in both rounds. */
      beliefDateDisambiguation?: boolean | undefined;
    };
  }): Promise<{
    results: SearchHit[];
    factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
    promptFactLines: string[];
    dateMathLines?: string[] | undefined;
    generated: GeneratorOutput;
  } | null> {
    const { profile, dto } = args;
    const refineQuery = args.generated.refineQuery?.trim();
    if (!profile.searchLoop || !refineQuery || refineQuery === dto.query) return null;
    try {
      // Audit 2026-08-19 P1: the refined retrieval inherits the FULL
      // caller filter contract (anchors, floors, mode, user scope) —
      // only the query text changes.
      const probe = await withSpan('synthesize.search_loop', () =>
        this.search.search(
          args.companyId,
          buildSecondaryDto(dto, { query: refineQuery }),
          args.callerScopes,
        ),
      );
      const union = applyEvidenceUnion(args.evidence, probe.results, profile.extraEvidenceCap);
      const prepared = this.prepareEvidence(union, args.prepareOpts);
      if ('empty' in prepared) return null;
      const promptFactLines = applyFactSuffixes(prepared.factLines, [
        args.updateStories,
        args.groundingQuotes,
      ]);
      const dateMathLines = profile.dateMath ? buildDateMathLines(prepared.results) : undefined;
      const generated = await withSpan('synthesize.generate_refined', () =>
        this.limiter.run(() =>
          // The round-2 call omits allowRefine — the one-round cap is structural.
          this.callGenerator(
            buildGeneratorArgs(args, { results: prepared.results, promptFactLines, dateMathLines }),
          ),
        ),
      );
      this.metrics?.countSynthesize('search_loop_refined');
      return {
        results: prepared.results,
        factIndex: prepared.factIndex,
        promptFactLines,
        dateMathLines,
        generated,
      };
    } catch (err) {
      this.logger.warn(
        `search-loop refine failed (${(err as Error).message}) — keeping the round-1 answer`,
      );
      return null;
    }
  }

  // The verdict/exit matrix lives in verdict.ts (V10.5 audit pass —
  // file budget headroom before the V11 features); the adapters keep
  // the call sites and the spec bindings unchanged.
  private finalizeVerdict(args: Parameters<typeof finalizeVerdict>[1]): SynthesizeResult {
    return finalizeVerdict({ metrics: this.metrics }, args);
  }

  private coverageAbstention(
    args: Parameters<typeof coverageAbstention>[1],
  ): SynthesizeResult | null {
    return coverageAbstention({ metrics: this.metrics, logger: this.logger }, args);
  }

  /**
   * The coverage-abstention seam (extracted from synthesize() for the
   * function-size gate). First the Optics §4.2 pre-answer focus capture — a
   * SERVING-NEUTRAL guarded no-op with verdict='none' / stage='preanswer', so
   * the abstention calibrator is fit on the same no-verifier signal it is
   * applied to (fit-shape = apply-shape §4.2). Then, ONLY in coverage mode,
   * resolve the adaptive gate (else undefined → the static floor,
   * byte-identical), and return the abstention result or null.
   */
  private async maybeCoverageAbstain(
    companyId: string,
    ctx: { lane: LaneId | null; query: string; decisionCtx?: DecisionContext },
    args: Parameters<typeof coverageAbstention>[1],
  ): Promise<SynthesizeResult | null> {
    const { lane, query } = ctx;
    const { profile, guardrails, results } = args;
    // The pre-answer focus capture + the adaptive gate BOTH apply only in the
    // regime where coverage-abstention actually runs (coverage mode, strict/
    // lenient). Capturing outside it would seed the pre-answer calibrator with
    // off-distribution samples ('answer'-mode / abstention-off queries never
    // face the abstain decision the calibrator predicts) — the same fit-shape
    // = apply-shape discipline the stage discriminator enforces (§4.2).
    const coverageRegime =
      profile.abstentionCalibration === 'coverage' &&
      (guardrails === 'strict' || guardrails === 'lenient');
    if (coverageRegime && this.focusSignal && FocusSignalService.captureEnabled()) {
      // `query` threads the Tier 5 language key into the pre-answer sample.
      // (No decisionId here by construction: the abstain decision is minted
      // AFTER the gate below decides — only the verdict-stage sample can
      // carry the join key.)
      await this.focusSignal.maybeCapture(
        companyId,
        { results, verdict: 'none', lane, query },
        'preanswer',
      );
    }
    const adaptive = coverageRegime
      ? await resolveAdaptiveAbstain(
          { focusSignal: this.focusSignal, logger: this.logger },
          companyId,
          { results, lane },
        )
      : undefined;
    const result = this.coverageAbstention({ ...args, ...(adaptive ? { adaptive } : {}) });
    // 0119 decision capture: ONE 'abstain' row per request where the gate
    // was LIVE (coverage regime), recording which action it took. Guarded
    // no-op unless OUTCOME_DECISION_CAPTURE is on and the writer is wired
    // (decision-emit.ts); claims the primary-decision slot when free.
    if (coverageRegime && ctx.decisionCtx) {
      captureAbstainDecision(this.decisions, companyId, {
        results,
        lane,
        adaptive,
        abstained: result !== null,
        decisionCtx: ctx.decisionCtx,
      });
    }
    return result;
  }

  /**
   * Guardrail + no-results prologue of synthesize(), extracted verbatim
   * (complexity budget). Returns `{empty}` with the early-return result,
   * or the prepared evidence for the generator.
   */
  /**
   * Build the per-request evidence-preparation options from the routed
   * lane + profile. Extracted from synthesize() to keep it under the
   * function-size gate; the field semantics live here.
   */
  private buildPrepareOpts(args: {
    answerMode: boolean;
    explain: boolean;
    lane: LaneId | null;
    asOf: string | undefined;
    profile: RetrievalProfile;
  }) {
    const { answerMode, explain, lane, asOf, profile } = args;
    return {
      answerMode,
      explain,
      elapsedAsOf: lane === 'temporal' ? asOf : undefined,
      // T2 and T6 both read off a code-sorted timeline.
      chronological: lane === 'enumeration' || lane === 'summary',
      // T5: recency marker on the newest fact of multi-statement slots
      // (knowledge-update misses answer STALE values) — active for any
      // routed request, independent of lane.
      markRecency: profile.lanes.has('recency'),
      // V12 mention anchoring: "(mentioned YYYY-MM-DD)" on stamped
      // facts whose anchor disagrees with validFrom by day.
      mentionDates: profile.mentionDates,
      // V13 dual-trace read side: "(context: …)" scene suffixes.
      sceneTraces: profile.sceneTraces,
    };
  }

  private prepareEvidence(
    evidence: SearchHit[],
    opts: {
      answerMode: boolean;
      explain: boolean;
      /** T1 temporal lane: asOf for precomputed [elapsed] annotations. */
      elapsedAsOf?: string | undefined;
      /** T2 enumeration lane: chronological fact-line ordering. */
      chronological?: boolean | undefined;
      /** T5: mark the newest fact of multi-statement slots. */
      markRecency?: boolean | undefined;
      /** V12: mention-date suffix on stamped facts (profile.mentionDates). */
      mentionDates?: boolean | undefined;
      /** V13: "(context: …)" scene suffix (profile.sceneTraces). */
      sceneTraces?: boolean | undefined;
    },
  ): { empty: SynthesizeResult } | ({ results: SearchHit[] } & ReturnType<typeof buildFactIndex>) {
    const {
      answerMode,
      explain,
      elapsedAsOf,
      chronological,
      markRecency,
      mentionDates,
      sceneTraces,
    } = opts;
    const guardrail = applyConformalGuardrail(evidence, {
      // 'answer' mode disables the CONFIDENCE floor by design: the whole
      // point is to commit to a best-effort answer instead of abstaining
      // when evidence is thin. It must NOT disable the SOURCE-TRUST floor
      // (audit W5 #26) — that filter is about who claimed the fact, not
      // about how sure we are, and answering from a distrusted source is
      // never what 'answer' mode was asking for.
      minCalibratedConfidence: answerMode ? 0 : this.minCalibratedConfidence,
      minFactTrust: this.minFactTrust,
    });
    const results = guardrail.kept;
    if (guardrail.droppedCount > 0) {
      this.logger.debug(
        `conformal guardrail dropped ${guardrail.droppedCount} fact(s) below ${this.minCalibratedConfidence}`,
      );
    }
    if (results.length === 0) {
      this.metrics?.countSynthesize('no_results');
      return {
        empty: attachDecisionLog(
          { answer: null, reason: 'no_results', citations: [], results: [] },
          explain ? [] : undefined,
        ),
      };
    }
    const { factIndex, factLines } = buildFactIndex(results, {
      elapsedAsOf,
      chronological,
      markRecency,
      mentionDates,
      sceneTraces,
    });
    if (factIndex.size === 0) {
      // Search returned entities but they were stripped to ids by
      // outputShape='ids' / token budget. Treat as no_results for
      // synthesis purposes — we have nothing to cite.
      this.metrics?.countSynthesize('no_results');
      return {
        empty: attachDecisionLog(
          { answer: null, reason: 'no_results', citations: [], results },
          explain ? buildDecisionLog(results, new Set()) : undefined,
        ),
      };
    }
    return { results, factIndex, factLines };
  }

  /**
   * Thin adapter over the generator client (V10 architecture pass) —
   * the orchestrator supplies its client/metrics/logger, the module owns
   * the call. (The verifier twin moved into fragment-zoom-seam.ts with
   * the verify stage — verifyAndZoom calls runVerifier directly.)
   */
  private async callGenerator(
    args: Omit<GenerateRequest, 'openai' | 'metrics' | 'logger'>,
  ): Promise<GeneratorOutput> {
    return runGenerator({
      openai: this.openai,
      metrics: this.metrics,
      logger: this.logger,
      ...args,
    });
  }
}
