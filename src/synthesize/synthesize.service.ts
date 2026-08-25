import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createOpenAiClientOrThrow } from '../ai/openai-client';
import { SearchService, SearchHit } from '../search/search.service';
import { Semaphore } from '../common/semaphore';
import { withSpan } from '../common/tracing';
import { clampLlmInputText } from '../common/input-limits';
import { getAbortSignal } from '../common/request-context';
import { pinUserScope } from '../auth/user-scope';
import { MetricsService } from '../metrics/metrics.service';
import { SynthesisGuardrails, SynthesizeDto } from './dto/synthesize.dto';
import { buildDecisionLog } from './decision-log';
import { applyConformalGuardrail } from './conformal-guardrail';
import { coverageAbstention, finalizeVerdict, unverifiedReturn } from './verdict';
import type { AbstainAdaptiveGate } from './verdict';
import {
  attachDecisionLog,
  buildSecondaryDto,
  evidenceConflicts,
  resolveAnswerFrames,
  resolveAnswerLang,
  resolveCitations,
  resolveLaneDateContext,
  resolveRoutedLane,
  serveCacheHit,
  verifierErrorResult,
} from './synthesize.helpers';
import { resolvePromptFrames, wantsTimelineEvidence } from './evidence-gates';
import { applyEvidenceUnion } from './evidence-union';
import { laneProbeDto, type LaneId } from './answer-router';
import { getActiveRetrievalProfile, type RetrievalProfile } from '../search/retrieval-profile';
import { buildFactIndex } from './fact-index';
import { resolveAnswerIntegrity, type FinalizeContext } from './answer-integrity';
import { applyFactSuffixes } from './update-story';
import { buildDateMathLines } from './date-math';
export { buildFactIndex } from './fact-index';
import { runGenerator, type GenerateRequest } from './generator-client';
import { runVerifier, type VerifierOutput } from './verifier';
import { miniCheckConsistent } from './minicheck-client';
export { buildGeneratorUserMessage } from './generator-prompt';
import { EvidenceCollectorService, type CollectedEvidence } from './evidence-collector.service';
import { L3EscalationService } from './l3-escalation.service';
import { FocusSignalService } from './focus-signal.service';
import {
  buildFocusSignal,
  calibratedConfidence,
  hasUsableCalibration,
  queryClassOf,
} from './focus-signal';
import type { FocusVerdict, PerClassCalibration } from './focus-signal';
import { LensSuppressionService } from './lens-suppression.service';
import { MultilingualLaneClassifierService } from './multilingual-lane-classifier.service';
import {
  AnswerCacheService,
  type AnswerCacheBeginResult,
} from '../answer-cache/answer-cache.service';
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

  async synthesize({
    companyId,
    dto,
    callerScopes,
    onProgress = NOOP_REPORTER,
    extraHits,
    profile = getActiveRetrievalProfile(),
  }: SynthesizeOptions): Promise<SynthesizeResult> {
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
    const laneProbeHits = await this.runLaneProbe({
      profile,
      lane,
      dto,
      companyId,
      callerScopes,
      baseHits: searchResult.results,
    });
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
    const abstained = await this.maybeCoverageAbstain(companyId, lane, {
      profile,
      guardrails,
      results,
      explain,
    });
    if (abstained) return abstained;

    // Every non-fact prompt section — transcript quotes, insights,
    // standing instructions — comes from the collector behind one
    // contract (V9 quality pass; all lanes concurrent inside). Running
    // it AFTER the empty/abstention exits also stops the pre-V9 waste
    // of an abandoned in-flight instruction probe on those paths.
    const {
      transcriptLines,
      insightLines,
      instructions,
      timelineEvidence,
      updateStories,
      groundingQuotes,
      strategyNotes,
    } = this.evidenceCollector
      ? await this.evidenceCollector.collect({
          profile,
          lane,
          companyId,
          query: dto.query,
          callerScopes,
          // Same fail-closed user scope the fact read path applies (0055).
          userId: dto.userId,
          // Audit 2026-08-19 P1: secondary searches inside the collector
          // (instruction probe) inherit the caller's filter contract.
          dto,
          factIds: [...factIndex.keys()],
          evidence,
        })
      : this.emptyCollected(profile, dto.query);

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

    // Phase 4.C — resolve the answer language. Explicit DTO wins;
    // otherwise we detect from the query (so a Russian question gets
    // a Russian answer by default without the caller having to opt in).
    const answerLang = resolveAnswerLang(dto);

    onProgress({
      stage: 'generate',
      message: `LLM grounding answer over ${factIndex.size} facts`,
    });
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
        transcriptLines,
        insightLines,
        instructions,
        timelineEvidence,
        strategyNotes,
      },
    });
    if ('failed' in produced) return produced.failed;
    const { generated } = produced;
    ({ results, factIndex, promptFactLines, dateMathLines } = produced);

    const citations = resolveCitations(generated.citedFactIds, generated.answer, factIndex);
    const citedSet = new Set(citations.map((c) => c.factId));
    const decisionLog = explain ? buildDecisionLog(results, citedSet) : undefined;

    const unverified = this.unverifiedReturn({
      guardrails,
      generated,
      citations,
      results,
      decisionLog,
    });
    if (unverified) return unverified;

    onProgress({ stage: 'verify', message: 'verifier checking claim grounding' });
    // Verifier — the corrective guardrail. Runs in strict and
    // lenient modes. Strict gates the answer behind a 'supported'
    // verdict; lenient surfaces the verdict but returns the answer
    // either way.
    // V11 §2 arm (b): lenient 'minicheck' delegates the judgment to
    // the local NLI; the verdict falls through to the SAME
    // finalizeVerdict gate below (verdict.ts treats the mode like
    // 'verifier'). A throw lands in the shared verifier_error catch.
    const nliMode = guardrails === 'lenient' && profile.abstentionCalibration === 'minicheck';
    let verdict: VerifierOutput;
    try {
      verdict = nliMode
        ? await this.miniCheckVerdict({
            answer: generated.answer,
            factLines: promptFactLines,
            transcriptLines,
            insightLines,
          })
        : await withSpan(
            'synthesize.verify',
            () =>
              this.limiter.run(() =>
                this.callVerifier({
                  query: dto.query,
                  answer: generated.answer,
                  factLines: promptFactLines,
                  // Audit W5 #22: the verifier used to see ONLY factLines,
                  // so an answer correctly built from transcript quotes or
                  // the computed interval table had claims present in no
                  // fact line — strict mode dropped correct answers, and
                  // lenient/answer shipped quoted L0 content with zero
                  // faithfulness scoring. It now audits against the same
                  // evidence the generator was given.
                  transcriptLines,
                  insightLines,
                  // W5 #22 parity for the mention record (V9 §2 closes the
                  // V8 gap): the auditor sees the same MENTION RECORD
                  // framing the generator saw — the collector computed it
                  // exactly once for both.
                  timelineEvidence,
                  // V10 §5: topic-coverage audit (relationship-claim
                  // strictness + the questionAnswered judgment).
                  topicCoverage: profile.verifierTopicCoverage,
                  // V13 date-table parity: the auditor sees the same
                  // computed table the generator saw.
                  dateMathLines,
                  // G4 strategyNotes are DELIBERATELY absent — the one
                  // documented exception to the W5 #22 parity invariant:
                  // advisory strategy notes are guidance, not evidence,
                  // and must never make an unsupported claim verify as
                  // supported (see verifier.ts + CollectedEvidence).
                  // V11 §2 arm (a): the audit may run on a stronger judge
                  // than the generator; empty override = same model.
                  model: profile.verifierModel || model,
                }),
              ),
            { 'synthesize.facts': factIndex.size },
          );
    } catch (err) {
      this.logger.warn(`Synthesize verifier failed: ${(err as Error).message}`);
      this.metrics?.countSynthesize('verifier_error');
      return verifierErrorResult({
        guardrails,
        answer: generated.answer,
        citations,
        results,
        decisionLog,
      });
    }

    // Optics-1 focus capture — SERVING-NEUTRAL guarded no-op (see method).
    await this.maybeCaptureFocusSignal(companyId, { results, verdict: verdict.verdict, lane });

    // G2 L3 escalation — the pre-abstention seam. On a verifier-fail with
    // an anchoring session it escalates ONCE to full-raw-session context
    // and returns the L3 answer when re-verification flips fail→pass;
    // else (null) the normal abstention/decline exit runs. Trigger matrix
    // + anchor requirement live in tryL3Escalation / the L3 service.
    // BOTH exits resolve the default-off verifier answer-integrity arm (Parts
    // A + C): on no-flip the primary finalizeAndAdmit runs it, and the L3 flip
    // path runs it too (its raw-transcript answer is the most exposed, so the
    // gate is end-to-end).
    return (
      (await this.tryL3Escalation({
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
      })) ??
      this.finalizeAndAdmit({ cache, dto, profile, model }, verdict, {
        answer: generated.answer,
        citations,
        results,
        guardrails,
        decisionLog,
        abstention: profile.abstentionCalibration,
      })
    );
  }

  /**
   * Optics-1 focus-signal capture — a guarded no-op when the flag is off
   * (or the service is absent). Extracted so synthesize() keeps a single
   * capture call on the serving path and stays within its line budget.
   * SERVING-NEUTRAL: nothing consumes the captured signal yet.
   */
  private async maybeCaptureFocusSignal(
    companyId: string,
    signal: { results: SearchHit[]; verdict: FocusVerdict; lane: LaneId | null },
  ): Promise<void> {
    if (!this.focusSignal || !FocusSignalService.captureEnabled()) return;
    await this.focusSignal.maybeCapture(companyId, signal);
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
  }): Promise<SynthesizeResult | null> {
    const { profile } = args;
    if (!this.l3 || !profile.l3Escalation) return null;
    const adaptiveL3 = await this.resolveAdaptiveL3(args.companyId);
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
      { cache: args.cache, dto: args.dto, profile: args.profile, model: args.model },
      l3.verdict,
      {
        answer: l3.answer,
        citations: l3.citations,
        results: args.results,
        guardrails: args.guardrails,
        decisionLog: args.explain
          ? buildDecisionLog(args.results, new Set(l3.citations.map((c) => c.factId)))
          : undefined,
        abstention: profile.abstentionCalibration,
      },
    );
  }

  /**
   * Optics-2 (§4.1) adaptive-L3 inputs. Returns the loaded per-class
   * calibration + escalate threshold ONLY when FOVEA_ADAPTIVE_L3 is on AND
   * a USABLE model (a class fit from real labeled samples) is persisted for
   * the tenant; otherwise undefined so the L3 lane takes its static
   * coverage-floor path. This is the load-bearing safety property: flag off
   * → undefined → static; no/empty/bootstrap model → undefined → static —
   * an unconfigured tenant serves byte-identically to the pre-Optics-2 L3.
   * The env reads live in the common layer (fovea-flags, via the
   * FocusSignalService statics), never in this engine dir (engine-gates
   * S5.2). A load failure returns undefined (fail-safe to static).
   */
  private async resolveAdaptiveL3(
    companyId: string,
  ): Promise<{ calibration: PerClassCalibration; threshold: number } | undefined> {
    if (!this.focusSignal || !FocusSignalService.adaptiveL3Enabled()) return undefined;
    try {
      const calibration = await this.focusSignal.loadCalibration(companyId);
      if (!hasUsableCalibration(calibration)) return undefined;
      return { calibration, threshold: FocusSignalService.adaptiveL3EscalateThreshold() };
    } catch (e) {
      this.logger.warn(
        `adaptive-L3 calibration load failed; static fallback: ${(e as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Optics §4.2 adaptive-abstention gate. Returns the calibrated pre-answer
   * {confidence, threshold} for the coverage-abstention decision ONLY when
   * FOVEA_ADAPTIVE_ABSTAIN is on AND a USABLE per-class PRE-ANSWER model is
   * persisted for the tenant; otherwise undefined so the gate takes its
   * static coverage-floor path. The confidence is computed from the SAME
   * per-fact scores the pre-answer capture used, with verdict='none' (the
   * constant that keys the pre-answer stage — fit-shape = apply-shape §4.2)
   * and the loaded PRE-ANSWER calibration. Load-bearing safety property: flag
   * off → undefined → static; no/empty/bootstrap model → undefined → static
   * — an unconfigured tenant serves byte-identically to the static coverage
   * abstention. The env reads live in the common layer (fovea-flags, via the
   * FocusSignalService statics), never in this engine dir (engine-gates
   * S5.2). A load failure returns undefined (fail-safe to static).
   */
  private async resolveAdaptiveAbstain(
    companyId: string,
    args: { results: SearchHit[]; lane: LaneId | null },
  ): Promise<AbstainAdaptiveGate | undefined> {
    if (!this.focusSignal || !FocusSignalService.adaptiveAbstainEnabled()) return undefined;
    try {
      const calibration = await this.focusSignal.loadCalibration(companyId, 'preanswer');
      if (!hasUsableCalibration(calibration)) return undefined;
      const factScores = args.results.flatMap((hit) => hit.facts.map((f) => f.score));
      const signal = buildFocusSignal({
        queryClass: queryClassOf(args.lane),
        factScores,
        verifierVerdict: 'none',
      });
      const confidence = calibratedConfidence(calibration, signal);
      return { confidence, threshold: FocusSignalService.adaptiveAbstainThreshold() };
    } catch (e) {
      this.logger.warn(
        `adaptive-abstain calibration load failed; static fallback: ${(e as Error).message}`,
      );
      return undefined;
    }
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
    const gate = await resolveAnswerIntegrity(
      { openai: this.openai, metrics: this.metrics, logger: this.logger, limiter: this.limiter },
      { ctx, verdict, args, defaultModel: this.defaultModel },
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
   * Collector-absent fallback (unit fixtures, trimmed deployments):
   * empty sections; only the timeline gate is still computed, exactly
   * as the collector would.
   */
  private emptyCollected(profile: RetrievalProfile, query: string): CollectedEvidence {
    return {
      transcriptLines: [],
      insightLines: [],
      instructions: undefined,
      timelineEvidence: wantsTimelineEvidence(profile, query),
      updateStories: undefined,
      groundingQuotes: undefined,
      strategyNotes: undefined,
    };
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
    const { profile, dto, collected } = args;
    let generated: GeneratorOutput;
    try {
      generated = await withSpan(
        'synthesize.generate',
        () =>
          this.limiter.run(() =>
            this.callGenerator({
              query: dto.query,
              factLines: args.promptFactLines,
              transcriptLines: collected.transcriptLines,
              insightLines: collected.insightLines,
              timelineEvidence: collected.timelineEvidence,
              // V10 frame switches — resolved once by the kernel
              // (evidence-gates.resolvePromptFrames), not inline.
              ...resolvePromptFrames(profile, collected.timelineEvidence),
              model: args.model,
              answerLang: args.answerLang,
              neverAbstain: args.guardrails === 'answer',
              // Date context (SYNTHESIZE_DATE_CONTEXT): anchor "today"
              // for the generator so relative/when questions resolve
              // against the facts' date stamps instead of guessing.
              // The temporal lane FORCES the anchor from asOf even when
              // the profile disables anchoring — elapsed annotations are
              // meaningless without a stated "today".
              dateContext: resolveLaneDateContext(profile, args.lane, dto.asOf),
              lane: args.lane,
              // §8 item 3: enumeration scope discipline.
              enumStrict: profile.enumStrict,
              // T7: standing instructions in their own section.
              instructions: collected.instructions,
              // T3: evidence-conditional — fires on write-side COMPETING
              // facts regardless of what the question looks like.
              conflicts: evidenceConflicts(args.results, profile),
              dateMathLines: args.dateMathLines,
              shapeInstruction: args.shapeInstruction,
              // G4 strategy lane: advisory notes, GENERATOR-ONLY — the
              // documented exception to the W5 #22 evidence-parity
              // invariant (advice, not evidence; see verifier.ts).
              strategyNotes: collected.strategyNotes,
              // V13 search loop: round 1 exposes the refine affordance.
              allowRefine: profile.searchLoop,
            }),
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
    return second
      ? { ...second, refined: true }
      : {
          results: args.results,
          factIndex: args.factIndex,
          promptFactLines: args.promptFactLines,
          dateMathLines: args.dateMathLines,
          generated,
          refined: false,
        };
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
    };
  }): Promise<{
    results: SearchHit[];
    factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
    promptFactLines: string[];
    dateMathLines?: string[] | undefined;
    generated: GeneratorOutput;
  } | null> {
    const { profile, dto, collected } = args;
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
          this.callGenerator({
            query: dto.query,
            factLines: promptFactLines,
            transcriptLines: collected.transcriptLines,
            insightLines: collected.insightLines,
            timelineEvidence: collected.timelineEvidence,
            ...resolvePromptFrames(profile, collected.timelineEvidence),
            model: args.model,
            answerLang: args.answerLang,
            neverAbstain: args.guardrails === 'answer',
            dateContext: resolveLaneDateContext(profile, args.lane, dto.asOf),
            lane: args.lane,
            enumStrict: profile.enumStrict,
            instructions: collected.instructions,
            conflicts: evidenceConflicts(prepared.results, profile),
            dateMathLines,
            shapeInstruction: args.shapeInstruction,
            strategyNotes: collected.strategyNotes,
          }),
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

  private unverifiedReturn(args: Parameters<typeof unverifiedReturn>[1]): SynthesizeResult | null {
    return unverifiedReturn({ metrics: this.metrics }, args);
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
    lane: LaneId | null,
    args: Parameters<typeof coverageAbstention>[1],
  ): Promise<SynthesizeResult | null> {
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
      await this.focusSignal.maybeCapture(
        companyId,
        { results, verdict: 'none', lane },
        'preanswer',
      );
    }
    const adaptive = coverageRegime
      ? await this.resolveAdaptiveAbstain(companyId, { results, lane })
      : undefined;
    return this.coverageAbstention({ ...args, ...(adaptive ? { adaptive } : {}) });
  }

  /**
   * Guardrail + no-results prologue of synthesize(), extracted verbatim
   * (complexity budget). Returns `{empty}` with the early-return result,
   * or the prepared evidence for the generator.
   */
  /**
   * Deterministic second retrievals per lane. T4 preference: the fixed
   * tastes probe (recommendation queries rarely surface stored tastes
   * by similarity). T6/T2 wide probe (flag-gated): PRF query built from
   * the base hits — recall breadth for summary/enumeration questions.
   * Degrades to [] on failure; other lanes probe nothing.
   */
  private async runLaneProbe({
    profile,
    lane,
    dto,
    companyId,
    callerScopes,
    baseHits,
  }: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    dto: SynthesizeDto;
    companyId: string;
    callerScopes: string[];
    baseHits: SearchHit[];
  }): Promise<SearchHit[]> {
    const probeDto = laneProbeDto(profile, lane, { query: dto.query, baseHits });
    if (!probeDto || getAbortSignal()?.aborted) return [];
    try {
      // Audit 2026-08-19 P1: the probe inherits the caller's full
      // filter contract; the lane supplies only its query and limit.
      const probe = await withSpan('synthesize.lane_probe', () =>
        this.search.search(companyId, buildSecondaryDto(dto, probeDto), callerScopes),
      );
      return probe.results;
    } catch (e) {
      this.logger.warn(
        `lane probe failed (lane=${lane}, companyId=${companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

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
   * same seam as callVerifier/runVerifier: the orchestrator supplies
   * its client/metrics/logger, the module owns the call.
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

  /**
   * V11 §2 arm (b): the local-NLI judgment mapped onto the verifier
   * verdict shape, so it falls through the SAME finalizeVerdict gate
   * (verdict.ts treats 'minicheck' like 'verifier'). The claim is the
   * whole answer text; the document is the evidence bundle the
   * generator saw. A refinement candidate from the V10 §5 lesson —
   * decompose the answer and check the connecting claim separately —
   * is deliberately NOT in v1 (measure the plain form first).
   */
  private async miniCheckVerdict(args: {
    answer: string;
    factLines: string[];
    transcriptLines: string[];
    insightLines: string[];
  }): Promise<VerifierOutput> {
    const document = [
      `Facts:\n${args.factLines.join('\n')}`,
      ...(args.transcriptLines.length
        ? [`Conversation excerpts:\n${args.transcriptLines.join('\n')}`]
        : []),
      ...(args.insightLines.length ? [`Derived insights:\n${args.insightLines.join('\n')}`] : []),
    ].join('\n\n');
    const consistent = await withSpan('synthesize.verify', () =>
      miniCheckConsistent({
        baseUrl: this.minicheckUrl,
        model: this.minicheckModel,
        document,
        claim: args.answer,
        signal: getAbortSignal(),
      }),
    );
    return consistent
      ? { verdict: 'supported', unsupportedClaims: [] }
      : { verdict: 'unsupported', unsupportedClaims: [args.answer] };
  }

  private async callVerifier(args: {
    query: string;
    answer: string;
    factLines: string[];
    transcriptLines?: string[] | undefined;
    insightLines?: string[] | undefined;
    timelineEvidence?: boolean | undefined;
    topicCoverage?: boolean | undefined;
    dateMathLines?: string[] | undefined;
    model: string;
  }): Promise<VerifierOutput> {
    return runVerifier({
      openai: this.openai,
      metrics: this.metrics,
      ...args,
    });
  }
}
