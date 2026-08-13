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
import { appendUpdateStories } from './update-story';
export { buildFactIndex } from './fact-index';
import { runGenerator } from './generator-client';
import type { GenerateRequest } from './generator-client';
import { runVerifier, type VerifierOutput } from './verifier';
export { buildGeneratorUserMessage } from './generator-prompt';
import type { SearchDto } from '../search/dto/search.dto';
import { EvidenceCollectorService } from './evidence-collector.service';
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
    // One user-scope pin for the WHOLE request (audit 2026-08-13 P1-4).
    // search() re-pins internally on its own clone, so without this a
    // user-bound token with an omitted userId read personal facts from
    // search but tenant-global-only supplemental evidence — the
    // collector lanes see dto.userId directly.
    dto = { ...dto, query: clamped.value, userId: pinUserScope(dto.userId) };
    const guardrails: SynthesisGuardrails =
      dto.synthesisGuardrails ?? this.defaultGuardrails;
    const model = dto.synthesisModel ?? this.defaultModel;
    const explain = dto.explain === true;

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
      query: dto.query,
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
    const prepared = this.prepareEvidence(evidence, {
      answerMode,
      explain,
      elapsedAsOf: lane === 'temporal' ? dto.asOf : undefined,
      // T2 and T6 both read off a code-sorted timeline.
      chronological: lane === 'enumeration' || lane === 'summary',
      // T5: recency marker on the newest fact of multi-statement slots
      // (knowledge-update misses answer STALE values) — active for any
      // routed request, independent of lane.
      markRecency: profile.lanes.has('recency'),
    });
    if ('empty' in prepared) return prepared.empty;
    const { results, factIndex, factLines } = prepared;

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
    } = this.evidenceCollector
      ? await this.evidenceCollector.collect({
          profile,
          lane,
          companyId,
          query: dto.query,
          callerScopes,
          // Same fail-closed user scope the fact read path applies (0055).
          userId: dto.userId,
          factIds: [...factIndex.keys()],
          evidence,
        })
      : {
          transcriptLines: [],
          insightLines: [],
          instructions: undefined,
          timelineEvidence: wantsTimelineEvidence(profile, dto.query),
          updateStories: undefined,
        };

    // V10 §2: update-story augmentation — evidence facts that
    // superseded an older value carry their history on the SAME lines
    // the generator and the verifier read (prompt-side only; citations
    // and ranking untouched).
    const promptFactLines =
      updateStories && updateStories.size > 0
        ? appendUpdateStories(factLines, updateStories)
        : factLines;

    // Phase 4.C — resolve the answer language. Explicit DTO wins;
    // otherwise we detect from the query (so a Russian question gets
    // a Russian answer by default without the caller having to opt in).
    const answerLang = resolveAnswerLang(dto);

    onProgress({
      stage: 'generate',
      message: `LLM grounding answer over ${factIndex.size} facts`,
    });
    let generated: GeneratorOutput;
    try {
      generated = await withSpan(
        'synthesize.generate',
        () =>
          this.limiter.run(() =>
            this.callGenerator({
              query: dto.query,
              factLines: promptFactLines,
              transcriptLines,
              insightLines,
              timelineEvidence,
              // V10 frame switches — resolved once by the kernel
              // (evidence-gates.resolvePromptFrames), not inline.
              ...resolvePromptFrames(profile, timelineEvidence),
              model,
              answerLang,
              neverAbstain: guardrails === 'answer',
              // Date context (SYNTHESIZE_DATE_CONTEXT): anchor "today"
              // for the generator so relative/when questions resolve
              // against the facts' date stamps instead of guessing.
              // The temporal lane FORCES the anchor from asOf even when
              // the profile disables anchoring — elapsed annotations are
              // meaningless without a stated "today".
              dateContext: resolveLaneDateContext(profile, lane, dto.asOf),
              lane,
              // T7: standing instructions in their own section.
              instructions,
              // T3: evidence-conditional — fires on write-side COMPETING
              // facts regardless of what the question looks like.
              conflicts: detectEvidenceConflicts(results, profile.lanes),
            }),
          ),
        { 'synthesize.facts': factIndex.size },
      );
    } catch (err) {
      this.logger.warn(
        `Synthesize generator failed: ${(err as Error).message}`,
      );
      this.metrics?.countSynthesize('generator_error');
      return attachDecisionLog(
        {
          answer: null,
          reason: 'generator_error',
          citations: [],
          results,
        },
        explain ? buildDecisionLog(results, new Set()) : undefined,
      );
    }

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
    let verdict: VerifierOutput;
    try {
      verdict = await withSpan(
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

    return this.finalizeVerdict({
      verdict: verdict.verdict,
      questionAnswered: verdict.questionAnswered,
      answer: generated.answer,
      citations,
      results,
      guardrails,
      decisionLog,
      abstention: profile.abstentionCalibration,
    });
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
    query,
    companyId,
    callerScopes,
    baseHits,
  }: {
    profile: RetrievalProfile;
    lane: LaneId | null;
    query: string;
    companyId: string;
    callerScopes: string[];
    baseHits: SearchHit[];
  }): Promise<SearchHit[]> {
    const probeDto = laneProbeDto(profile, lane, { query, baseHits });
    if (!probeDto) return [];
    if (getAbortSignal()?.aborted) return [];
    try {
      const probe = await withSpan('synthesize.lane_probe', () =>
        this.search.search(companyId, probeDto as SearchDto, callerScopes),
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
    },
  ):
    | { empty: SynthesizeResult }
    | ({ results: SearchHit[] } & ReturnType<typeof buildFactIndex>) {
    const { answerMode, explain, elapsedAsOf, chronological, markRecency } =
      opts;
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

  private async callVerifier(args: {
    query: string;
    answer: string;
    factLines: string[];
    transcriptLines?: string[];
    insightLines?: string[];
    timelineEvidence?: boolean;
    topicCoverage?: boolean;
    model: string;
  }): Promise<VerifierOutput> {
    return runVerifier({
      openai: this.openai,
      metrics: this.metrics,
      ...args,
    });
  }
}
