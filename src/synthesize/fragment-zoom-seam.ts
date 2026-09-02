import type OpenAI from 'openai';
import type { MetricsService } from '../metrics/metrics.service';
import type { MemoryDecisionService } from '../outcomes/memory-decision.service';
import type { SynthesisGuardrails, SynthesizeDto } from './dto/synthesize.dto';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SearchHit } from '../search/search.service';
import type { GeneratorOutput, SynthesizeResult } from './synthesize.types';
import type { Citation } from './fact-index';
import { fragmentZoomEnabled, fragmentZoomMaxChars } from '../common/fovea-flags';
import { withSpan } from '../common/tracing';
import { getAbortSignal } from '../common/request-context';
import { runVerifier, type VerifierOutput } from './verifier';
import { miniCheckVerdict } from './minicheck-client';
import { verifierErrorResult } from './synthesize.helpers';
import { verifierPasses } from './l3-escalation';
import { runFragmentZoom, type ZoomCandidate } from './fragment-zoom';
import { captureZoomDecision, type DecisionContext } from './decision-emit';

/**
 * The corrective-VERIFIER stage + the MM-zoom PR3 fragment-zoom step
 * (FOVEA_FRAGMENT_ZOOM), one module behind one seam — extracted WHOLE
 * from synthesize.service.ts (file/function budgets, the
 * resolveAnswerIntegrity deps idiom). Deliberately one module: the
 * primary audit and the zoom re-verify build their VerifyRequest side by
 * side here, so the "same audit, only the fragment lines enriched"
 * parity holds by construction, not by convention.
 *
 * verifyAndZoom = the stage: run the primary verifier (LLM judge, or the
 * local NLI when abstention='minicheck' in lenient mode — V11 §2 arm b),
 * fail to the historical verifier_error result on a throw, hand the
 * PRE-zoom verdict to the caller's onPrimaryVerdict callback (the
 * Optics-1 focus capture — the sample must see the primary verdict,
 * fit-shape discipline), then apply the zoom step.
 *
 * tryFragmentZoom = the step. Gates, in order: flag on (read via the
 * common-layer resolver — no direct env read), LLM-verifier path only
 * (an NLI verdict is not the judge the zoom re-runs — skip ⇒ static),
 * the fenced reader wired, and the primary verdict FAILED the shared
 * flip test (verifierPasses — the L3 fail notion). Then ONE bounded
 * zoom (fragment-zoom.ts): fetch fuller DERIVED TEXT of the truncated
 * rendered fragments through the lane's own fence stack — NEVER raw
 * bytes; those stay exclusively behind the EVIDENCE_RAW_READ_ENABLED
 * gateway (EvidenceReadService) — and RE-VERIFY ONLY. The answer is
 * NEVER regenerated.
 *
 * The step returns the FLIPPED verdict or null. Every failure path —
 * including the wrapper's own guard — returns null: the zoom can only
 * ADD a flipped serve, never lose the static downgrade. One step by
 * construction: the flow is linear and a flipped verdict passes the very
 * gate that triggers zooming.
 */

/** The fenced fuller-text reader (FragmentLaneService.fullerTexts
 *  satisfies this structurally — a port, not an import, so this module
 *  never depends on the lane service). */
export interface FragmentZoomFetchPort {
  fullerTexts(opts: {
    companyId: string;
    reprIds: string[];
    maxChars: number;
    callerScopes: string[];
    userId?: string | undefined;
  }): Promise<Map<string, string>>;
}

export interface FragmentZoomSeamDeps {
  openai: OpenAI;
  metrics?: MetricsService | undefined;
  logger: { warn(message: string): void };
  limiter: { run<T>(fn: () => Promise<T>): Promise<T> };
  fragmentLane?: FragmentZoomFetchPort | undefined;
  decisions?: MemoryDecisionService | undefined;
  /** The local NLI endpoint for abstention='minicheck' (V11 §2 arm b). */
  minicheck: { baseUrl: string; model: string };
}

/** The per-request serving context — the orchestrator's cacheArgs
 *  bundle, passed as-is. */
export interface VerifyStageCtx {
  companyId: string;
  dto: SynthesizeDto;
  callerScopes: string[];
  profile: RetrievalProfile;
  model: string;
  guardrails: SynthesisGuardrails;
}

export interface VerifyStageArgs {
  ctx: VerifyStageCtx;
  generated: GeneratorOutput;
  /** The collector's rendered sections (evidence parity: generator,
   *  primary audit and zoom re-verify all read the same lines). */
  collected: {
    fragmentLines: string[];
    fragmentZoom: ZoomCandidate[];
    transcriptLines: string[];
    insightLines: string[];
    timelineEvidence: boolean;
  };
  promptFactLines: string[];
  dateMathLines?: string[] | undefined;
  citations: Citation[];
  results: SearchHit[];
  decisionLog: Parameters<typeof verifierErrorResult>[0]['decisionLog'];
  /** factIndex.size — the synthesize.verify span attribute. */
  factCount: number;
  decisionCtx: DecisionContext;
  /** Invoked with the PRE-zoom verdict (the focus-capture hook). */
  onPrimaryVerdict: (verdict: VerifierOutput) => Promise<void>;
}

/**
 * The stage: primary verify → verifier_error exit on a throw →
 * onPrimaryVerdict → the zoom step. Moved verbatim from
 * synthesize.service.ts (see the module docblock); with
 * FOVEA_FRAGMENT_ZOOM off the returned verdict IS the primary verdict —
 * byte-identical serving.
 */
export async function verifyAndZoom(
  deps: FragmentZoomSeamDeps,
  args: VerifyStageArgs,
): Promise<{ verdict: VerifierOutput } | { failed: SynthesizeResult }> {
  const { ctx, collected, generated } = args;
  const { dto, profile, model, guardrails } = ctx;
  // V11 §2 arm (b): lenient 'minicheck' delegates the judgment to the
  // local NLI; the verdict falls through to the SAME finalizeVerdict
  // gate (verdict.ts treats the mode like 'verifier'). A throw lands in
  // the shared verifier_error catch.
  const nliMode = guardrails === 'lenient' && profile.abstentionCalibration === 'minicheck';
  let verdict: VerifierOutput;
  try {
    verdict = nliMode
      ? await miniCheckVerdict(
          {
            baseUrl: deps.minicheck.baseUrl,
            model: deps.minicheck.model,
            signal: getAbortSignal(),
          },
          {
            answer: generated.answer,
            factLines: args.promptFactLines,
            transcriptLines: collected.transcriptLines,
            insightLines: collected.insightLines,
            // MM-zoom PR2 parity: the media lines the generator saw.
            fragmentLines: collected.fragmentLines,
          },
        )
      : await withSpan(
          'synthesize.verify',
          () =>
            deps.limiter.run(() =>
              runVerifier({
                openai: deps.openai,
                metrics: deps.metrics,
                query: dto.query,
                answer: generated.answer,
                factLines: args.promptFactLines,
                // Audit W5 #22: the verifier used to see ONLY factLines,
                // so an answer correctly built from transcript quotes or
                // the computed interval table had claims present in no
                // fact line — strict mode dropped correct answers, and
                // lenient/answer shipped quoted L0 content with zero
                // faithfulness scoring. It now audits against the same
                // evidence the generator was given.
                transcriptLines: collected.transcriptLines,
                insightLines: collected.insightLines,
                // W5 #22 parity for the mention record (V9 §2 closes the
                // V8 gap): the auditor sees the same MENTION RECORD
                // framing the generator saw — the collector computed it
                // exactly once for both.
                timelineEvidence: collected.timelineEvidence,
                // V10 §5: topic-coverage audit (relationship-claim
                // strictness + the questionAnswered judgment).
                topicCoverage: profile.verifierTopicCoverage,
                // V13 date-table parity: the auditor sees the same
                // computed table the generator saw.
                dateMathLines: args.dateMathLines,
                // MM-zoom PR2 parity: the same media lines the
                // generator saw (the 0113 capabilityEvidenceLines seam).
                capabilityEvidenceLines: collected.fragmentLines,
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
          { 'synthesize.facts': args.factCount },
        );
  } catch (err) {
    deps.logger.warn(`Synthesize verifier failed: ${(err as Error).message}`);
    deps.metrics?.countSynthesize('verifier_error');
    return {
      failed: verifierErrorResult({
        guardrails,
        answer: generated.answer,
        citations: args.citations,
        results: args.results,
        decisionLog: args.decisionLog,
      }),
    };
  }
  // Optics-1 focus capture — the sample sees the PRE-zoom verdict.
  await args.onPrimaryVerdict(verdict);
  // MM-zoom PR3: the ONE bounded zoom step; null ⇒ the primary verdict
  // stands and every downstream byte matches the pre-zoom flow.
  const zoomed = await tryFragmentZoom(deps, {
    ctx,
    nliMode,
    verdict,
    generated,
    collected,
    promptFactLines: args.promptFactLines,
    dateMathLines: args.dateMathLines,
    decisionCtx: args.decisionCtx,
  });
  return { verdict: zoomed ?? verdict };
}

interface FragmentZoomSeamArgs {
  /** The per-request serving context (the cacheArgs bundle). */
  ctx: VerifyStageCtx;
  /** True when the verdict came from the local NLI judge (minicheck). */
  nliMode: boolean;
  verdict: VerifierOutput;
  generated: GeneratorOutput;
  /** The collector's rendered sections (evidence parity: the re-verify
   *  reuses them verbatim, only the fragment lines are enriched). */
  collected: {
    fragmentLines: string[];
    fragmentZoom: ZoomCandidate[];
    transcriptLines: string[];
    insightLines: string[];
    timelineEvidence: boolean;
  };
  promptFactLines: string[];
  dateMathLines?: string[] | undefined;
  decisionCtx: DecisionContext;
}

async function tryFragmentZoom(
  deps: FragmentZoomSeamDeps,
  args: FragmentZoomSeamArgs,
): Promise<VerifierOutput | null> {
  const { collected } = args;
  const { companyId, dto, callerScopes, profile, model } = args.ctx;
  if (!fragmentZoomEnabled()) return null;
  if (args.nliMode || !deps.fragmentLane) return null;
  if (verifierPasses(args.verdict, profile.verifierTopicCoverage)) return null;
  try {
    const fragmentLane = deps.fragmentLane;
    const userId = dto.userId || undefined;
    const result = await runFragmentZoom(
      {
        fetchFullerTexts: (reprIds, maxChars) =>
          fragmentLane.fullerTexts({
            companyId,
            reprIds,
            maxChars,
            callerScopes,
            userId,
          }),
        // Re-verify ONLY: the SAME audit request as the primary verifier
        // call, with the zoomed lines standing in for the rendered
        // fragment lines (every other section untouched).
        reverify: (zoomedLines) =>
          deps.limiter.run(() =>
            runVerifier({
              openai: deps.openai,
              metrics: deps.metrics,
              query: dto.query,
              answer: args.generated.answer,
              factLines: args.promptFactLines,
              transcriptLines: collected.transcriptLines,
              insightLines: collected.insightLines,
              timelineEvidence: collected.timelineEvidence,
              topicCoverage: profile.verifierTopicCoverage,
              dateMathLines: args.dateMathLines,
              capabilityEvidenceLines: zoomedLines,
              model: profile.verifierModel || model,
            }),
          ),
        metrics: deps.metrics,
        warn: (m) => deps.logger.warn(`${m} (companyId=${companyId})`),
      },
      {
        topicCoverage: profile.verifierTopicCoverage,
        fragmentLines: collected.fragmentLines,
        candidates: collected.fragmentZoom,
        citedFragmentIds: args.generated.citedFragmentIds ?? [],
        maxChars: fragmentZoomMaxChars(),
      },
    );
    // 0119 decision capture — once per EVALUATED step (mirrors the
    // metric); guarded no-op unless OUTCOME_DECISION_CAPTURE is on.
    captureZoomDecision(deps.decisions, companyId, {
      result,
      decisionCtx: args.decisionCtx,
    });
    return result.verdict ?? null;
  } catch (e) {
    // Fail-safe to static: zoom must never break the serve/downgrade.
    deps.logger.warn(`fragment zoom seam failed (companyId=${companyId}): ${(e as Error).message}`);
    return null;
  }
}
