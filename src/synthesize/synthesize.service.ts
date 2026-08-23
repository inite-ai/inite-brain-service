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
import {
  SynthesisGuardrails,
  SynthesizeDto,
} from './dto/synthesize.dto';
import { buildDecisionLog } from './decision-log';
import { applyConformalGuardrail } from './conformal-guardrail';
import {
  coverageAbstention,
  finalizeVerdict,
  unverifiedReturn,
} from './verdict';
import {
  attachDecisionLog,
  buildSecondaryDto,
  resolveAnswerFrames,
  resolveAnswerLang,
  resolveCitations,
  resolveLaneDateContext,
  verifierErrorResult,
} from './synthesize.helpers';
import {
  resolvePromptFrames,
  wantsTimelineEvidence,
} from './evidence-gates';
import { applyEvidenceUnion } from './evidence-union';
import {
  routeLane,
  laneProbeDto,
  detectEvidenceConflicts,
  type LaneId,
} from './answer-router';
export { detectEvidenceConflicts } from './answer-router';
import {
  getActiveRetrievalProfile,
  type RetrievalProfile,
} from '../search/retrieval-profile';
import { buildFactIndex } from './fact-index';
import { applyFactSuffixes } from './update-story';
import { buildDateMathLines } from './date-math';
export { buildFactIndex } from './fact-index';
import { runGenerator } from './generator-client';
import type { GenerateRequest } from './generator-client';
import { runVerifier, type VerifierOutput } from './verifier';
import { miniCheckConsistent } from './minicheck-client';
export { buildGeneratorUserMessage } from './generator-prompt';
import { EvidenceCollectorService } from './evidence-collector.service';
import type { CollectedEvidence } from './evidence-collector.service';
import { L3EscalationService } from './l3-escalation.service';
import {
  AnswerCacheService,
  type AnswerCacheBeginResult,
} from '../answer-cache/answer-cache.service';
import {
  NOOP_REPORTER,
  type ProgressReporter,
} from '../mcp/progress-reporter';

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
import type {
  GeneratorOutput,
  SynthesizeResult,
} from './synthesize.types';

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
  ) {
    this.openai = createOpenAiClientOrThrow(this.configService);
    this.defaultModel = this.configService.get<string>(
      'SYNTHESIZE_MODEL',
      this.configService.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    );
    this.limiter = new Semaphore(
      parseInt(
        this.configService.get<string>('SYNTHESIZE_CONCURRENCY', '4'),
        10,
      ),
    );
    const raw = this.configService.get<string>(
      'SYNTHESIZE_DEFAULT_GUARDRAILS',
      'strict',
    );
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
    this.minicheckUrl = this.configService.get<string>(
      'MINICHECK_URL',
      'http://127.0.0.1:11434',
    );
    this.minicheckModel = this.configService.get<string>(
      'MINICHECK_MODEL',
      'bespoke-minicheck',
    );
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
    const guardrails: SynthesisGuardrails =
      dto.synthesisGuardrails ?? this.defaultGuardrails;
    const model = dto.synthesisModel ?? this.defaultModel;
    const explain = dto.explain === true;

    // G1 answer cache (SYNTHESIZE_ANSWER_CACHE): exact-key serve with
    // check-on-read fact-lifecycle gating, BEFORE retrieval; a miss
    // carries the key context to the admit hook (finalizeAndAdmit).
    const cacheArgs = { companyId, dto, callerScopes, profile, model, guardrails };
    const cache = await this.answerCache?.begin(cacheArgs);
    if (cache?.hit) return cache.hit;

    // Typed dispatch: lane detection is lexical and free, so it runs
    // before retrieval — the preference lane adds a deterministic
    // second probe that similarity search would never surface.
    const lane: LaneId | null = routeLane(profile, dto.query);

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
      laneProbeHits.length > 0
        ? [...(extraHits ?? []), ...laneProbeHits]
        : extraHits,
      profile.extraEvidenceCap,
    );

    const answerMode = guardrails === 'answer';
    const prepareOpts = {
      answerMode,
      explain,
      elapsedAsOf: lane === 'temporal' ? dto.asOf : undefined,
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
    const prepared = this.prepareEvidence(evidence, prepareOpts);
    if ('empty' in prepared) return prepared.empty;
    // `let`: the V13 search loop may replace the evidence set with the
    // refined round's union before citations resolve.
    let { results, factIndex } = prepared;
    const { factLines } = prepared;

    // V9 §4 memory-coverage abstention (strict/lenient only — 'answer'
    // is a caller-level never-abstain contract).
    const abstained = this.coverageAbstention({
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
    let promptFactLines = applyFactSuffixes(factLines, [
      updateStories,
      groundingQuotes,
    ]);

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

    const citations = resolveCitations(
      generated.citedFactIds,
      generated.answer,
      factIndex,
    );
    const citedSet = new Set(citations.map((c) => c.factId));
    const decisionLog = explain
      ? buildDecisionLog(results, citedSet)
      : undefined;

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
    const nliMode =
      guardrails === 'lenient' && profile.abstentionCalibration === 'minicheck';
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

    // G2 L3 escalation — the pre-abstention seam. On a verifier-fail with
    // an anchoring session it escalates ONCE to full-raw-session context
    // and returns the L3 answer when re-verification flips fail→pass;
    // else (null) the normal abstention/decline exit runs. Trigger matrix
    // + anchor requirement live in tryL3Escalation / the L3 service.
    return (
      (await this.tryL3Escalation({
        cache, verdict, companyId, callerScopes, dto, profile, lane, model,
        answerLang, refineAttempted: produced.refined, results, factIndex,
        promptFactLines, dateMathLines, guardrails, explain,
      })) ??
      this.finalizeAndAdmit(cache, verdict, {
        answer: generated.answer, citations, results,
        guardrails, decisionLog, abstention: profile.abstentionCalibration,
      })
    );
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
    dateMathLines?: string[];
    guardrails: SynthesisGuardrails;
    explain: boolean;
  }): Promise<SynthesizeResult | null> {
    const { profile } = args;
    if (!this.l3 || !profile.l3Escalation) return null;
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
    });
    if (!l3) return null;
    return this.finalizeAndAdmit(args.cache, l3.verdict, {
      answer: l3.answer,
      citations: l3.citations,
      results: args.results,
      guardrails: args.guardrails,
      decisionLog: args.explain
        ? buildDecisionLog(args.results, new Set(l3.citations.map((c) => c.factId)))
        : undefined,
      abstention: profile.abstentionCalibration,
    });
  }

  /**
   * Verdict exit + G1 write-through admission, one seam (extracted
   * from synthesize() for the function-size gates). Only a
   * verifier-supported grounded answer reaches the cache — admit()
   * re-checks verdict/answer/reason/citations and no-ops otherwise,
   * so abstentions, unverified returns, low_coverage and partial
   * verdicts are never cached.
   */
  private async finalizeAndAdmit(
    cache: AnswerCacheBeginResult | undefined,
    verdict: VerifierOutput,
    args: Omit<
      Parameters<typeof finalizeVerdict>[1],
      'verdict' | 'questionAnswered'
    >,
  ): Promise<SynthesizeResult> {
    const final = this.finalizeVerdict({
      verdict: verdict.verdict,
      questionAnswered: verdict.questionAnswered,
      ...args,
    });
    if (cache?.ctx) {
      await this.answerCache?.admit(cache.ctx, final, verdict.verdict);
    }
    return final;
  }

  /**
   * Collector-absent fallback (unit fixtures, trimmed deployments):
   * empty sections; only the timeline gate is still computed, exactly
   * as the collector would.
   */
  private emptyCollected(
    profile: RetrievalProfile,
    query: string,
  ): CollectedEvidence {
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
      dateMathLines?: string[];
    },
  ): Promise<
    | { failed: SynthesizeResult }
    | {
        results: SearchHit[];
        factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
        promptFactLines: string[];
        dateMathLines?: string[];
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
              conflicts: detectEvidenceConflicts(args.results, profile.lanes),
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
      this.logger.warn(
        `Synthesize generator failed: ${(err as Error).message}`,
      );
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
    updateStories?: Map<string, string>;
    /** Multiworld §10 facts-as-keys: quotes for the ROUND-1 top facts —
     *  refined-in facts stand without quotes (unmatched lines pass). */
    groundingQuotes?: Map<string, string>;
    shapeInstruction?: string;
    collected: {
      transcriptLines: string[];
      insightLines: string[];
      instructions?: string[];
      timelineEvidence: boolean;
      /** G4 advisory notes — generator-only (parity exception). */
      strategyNotes?: string[];
    };
  }): Promise<{
    results: SearchHit[];
    factIndex: ReturnType<typeof buildFactIndex>['factIndex'];
    promptFactLines: string[];
    dateMathLines?: string[];
    generated: GeneratorOutput;
  } | null> {
    const { profile, dto, collected } = args;
    const refineQuery = args.generated.refineQuery?.trim();
    if (!profile.searchLoop || !refineQuery || refineQuery === dto.query) {
      return null;
    }
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
      const union = applyEvidenceUnion(
        args.evidence,
        probe.results,
        profile.extraEvidenceCap,
      );
      const prepared = this.prepareEvidence(union, args.prepareOpts);
      if ('empty' in prepared) return null;
      const promptFactLines = applyFactSuffixes(prepared.factLines, [
        args.updateStories,
        args.groundingQuotes,
      ]);
      const dateMathLines = profile.dateMath
        ? buildDateMathLines(prepared.results)
        : undefined;
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
            conflicts: detectEvidenceConflicts(prepared.results, profile.lanes),
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
  private finalizeVerdict(
    args: Parameters<typeof finalizeVerdict>[1],
  ): SynthesizeResult {
    return finalizeVerdict({ metrics: this.metrics }, args);
  }

  private unverifiedReturn(
    args: Parameters<typeof unverifiedReturn>[1],
  ): SynthesizeResult | null {
    return unverifiedReturn({ metrics: this.metrics }, args);
  }

  private coverageAbstention(
    args: Parameters<typeof coverageAbstention>[1],
  ): SynthesizeResult | null {
    return coverageAbstention(
      { metrics: this.metrics, logger: this.logger },
      args,
    );
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
    if (!probeDto) return [];
    if (getAbortSignal()?.aborted) return [];
    try {
      // Audit 2026-08-19 P1: the probe inherits the caller's full
      // filter contract; the lane supplies only its query and limit.
      const probe = await withSpan('synthesize.lane_probe', () =>
        this.search.search(
          companyId,
          buildSecondaryDto(dto, probeDto),
          callerScopes,
        ),
      );
      return probe.results;
    } catch (e) {
      this.logger.warn(
        `lane probe failed (lane=${lane}, companyId=${companyId}): ${(e as Error).message}`,
      );
      return [];
    }
  }

  private prepareEvidence(
    evidence: SearchHit[],
    opts: {
      answerMode: boolean;
      explain: boolean;
      /** T1 temporal lane: asOf for precomputed [elapsed] annotations. */
      elapsedAsOf?: string;
      /** T2 enumeration lane: chronological fact-line ordering. */
      chronological?: boolean;
      /** T5: mark the newest fact of multi-statement slots. */
      markRecency?: boolean;
      /** V12: mention-date suffix on stamped facts (profile.mentionDates). */
      mentionDates?: boolean;
      /** V13: "(context: …)" scene suffix (profile.sceneTraces). */
      sceneTraces?: boolean;
    },
  ):
    | { empty: SynthesizeResult }
    | ({ results: SearchHit[] } & ReturnType<typeof buildFactIndex>) {
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
      ...(args.insightLines.length
        ? [`Derived insights:\n${args.insightLines.join('\n')}`]
        : []),
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
    transcriptLines?: string[];
    insightLines?: string[];
    timelineEvidence?: boolean;
    topicCoverage?: boolean;
    dateMathLines?: string[];
    model: string;
  }): Promise<VerifierOutput> {
    return runVerifier({
      openai: this.openai,
      metrics: this.metrics,
      ...args,
    });
  }
}
