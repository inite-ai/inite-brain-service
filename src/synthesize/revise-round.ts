import type { MetricsService } from '../metrics/metrics.service';
import { traceArtifact } from '../common/debug-trace';
import { withSpan } from '../common/tracing';
import type { GeneratorOutput, SynthesizeResult } from './synthesize.types';
import type { VerifierOutput } from './verifier';
import type { SearchHit } from '../search/search.service';
import type { GenerateRequest } from './generator-client';
import type { Citation } from './fact-index';
import type { LaneId } from './answer-router';
import type { DecisionLogEntry } from './decision-log';
import {
  verifyAndZoom,
  type FragmentZoomSeamDeps,
  type VerifyStageArgs,
  type VerifyStageCtx,
} from './fragment-zoom-seam';
import { buildDecisionLog } from './decision-log';
import { buildGeneratorArgs, resolveCitations, resolveLaneDateContext } from './synthesize.helpers';
import type { DecisionContext } from './decision-emit';

/**
 * The revision round: when the grounding audit returns `partial`, the
 * answer is rewritten once with the audit's findings and re-verified.
 *
 * WHY. Under strict guardrails a `partial` verdict served NOTHING — the
 * whole answer nulled for one sentence the auditor would not carry.
 * Measured on the 2026-09-18 dogfood: "what is due this week" listed
 * the board decision, the vacation cover and the 30 September deadline
 * correctly and was thrown away for "her absence begins next week"
 * and "no other meetings are recorded"; "how did the budget change"
 * for "the earlier amount is not stated". The auditor names the exact
 * spans it rejects, so the fix is the standard verify → revise loop
 * (Chain-of-Verification / Self-Refine): the generator sees its own
 * answer and those spans against the same evidence, keeps what was
 * supported, drops or corrects the rest, and the auditor judges the
 * rewrite. One round, only on `partial` — an `unsupported` verdict is a
 * hallucination and stays an abstention.
 *
 * The auditor's `questionAnswered` does not gate the round. It is one
 * sampled judgment, and on 2026-09-20 it said "no" to evidence that did
 * answer (`moved_to: Braga` for "where does he live") — the same
 * question, asked again, got "yes" and an answer. A `partial` with
 * named unsupported spans already means the auditor found supported
 * claims; the rewrite keeps those and the auditor judges the rewrite
 * afresh, `questionAnswered` included. If the evidence truly does not
 * answer, the rewrite abstains or the second audit says so — the round
 * costs one generator and one auditor call in that case and changes
 * nothing; when the first "no" was the sample's noise, it is the
 * difference between an answer and a null.
 */
export interface ReviseRoundDeps {
  metrics?: MetricsService | undefined;
  logger: { warn(message: string): void };
}

export interface ReviseRoundArgs {
  verdict: VerifierOutput;
  generated: GeneratorOutput;
  /** The local NLI arm judges differently and names no claims. */
  nliMode: boolean;
  /** The generator, called with the revision frame (buildGeneratorArgs `revise`). */
  regenerate: (revise: { answer: string; unsupportedClaims: string[] }) => Promise<GeneratorOutput>;
  /** The same audit the primary verdict came from, over the rewrite. */
  reverify: (
    generated: GeneratorOutput,
  ) => Promise<{ verdict: VerifierOutput } | { failed: unknown }>;
}

/** Whether a verdict is the shape a revision can repair. */
function revisable(verdict: VerifierOutput, nliMode: boolean): boolean {
  return !nliMode && verdict.verdict === 'partial' && (verdict.unsupportedClaims?.length ?? 0) > 0;
}

/**
 * The rewrite and its verdict, or null when the round did not run or
 * did not produce a usable rewrite (the caller keeps the primary
 * verdict and answer). A rewrite that abstains is returned as such —
 * the generator concluded nothing supported answers the query, which
 * the verdict layer serves as the abstention it is.
 */
async function reviseUnsupported(
  deps: ReviseRoundDeps,
  args: ReviseRoundArgs,
): Promise<{ generated: GeneratorOutput; verdict: VerifierOutput } | null> {
  if (!revisable(args.verdict, args.nliMode)) return null;
  try {
    const revised = await withSpan('synthesize.revise', () =>
      args.regenerate({
        answer: args.generated.answer,
        unsupportedClaims: args.verdict.unsupportedClaims ?? [],
      }),
    );
    if (!revised.answer.trim() || revised.answer.trim() === args.generated.answer.trim()) {
      traceArtifact('synthesize.revise', { outcome: 'unchanged' });
      return null;
    }
    const reverified = await withSpan('synthesize.reverify', () => args.reverify(revised));
    if ('failed' in reverified) {
      traceArtifact('synthesize.revise', { outcome: 'reverify_failed' });
      return null;
    }
    traceArtifact('synthesize.revise', {
      outcome: reverified.verdict.verdict,
      unsupportedClaims: reverified.verdict.unsupportedClaims,
    });
    deps.metrics?.countSynthesize('revised');
    return { generated: revised, verdict: reverified.verdict };
  } catch (err) {
    deps.logger.warn(
      `revision round failed (${(err as Error).message}) — keeping the audited answer`,
    );
    return null;
  }
}

/** What the audit stage borrows from the orchestrator. */
export interface AuditPorts {
  metrics?: MetricsService | undefined;
  logger: { warn(message: string): void };
  verifyDeps: FragmentZoomSeamDeps;
  /** One generator call, inside the orchestrator's limiter. */
  generate: (
    args: Omit<GenerateRequest, 'openai' | 'metrics' | 'logger'>,
  ) => Promise<GeneratorOutput>;
  /** Optics-1 focus capture — sees the PRE-zoom primary verdict only. */
  captureFocus: (
    companyId: string,
    sample: {
      results: SearchHit[];
      verdict: VerifierOutput['verdict'];
      lane: LaneId | null;
      decisionId?: string | undefined;
    },
    query: string,
  ) => Promise<void>;
}

export interface AuditArgs {
  ctx: VerifyStageCtx;
  lane: LaneId | null;
  explain: boolean;
  /** The round's generator context (buildGeneratorArgs' first argument). */
  produceArgs: Parameters<typeof buildGeneratorArgs>[0];
  round: {
    results: SearchHit[];
    factIndex: Map<string, Citation>;
    promptFactLines: string[];
    dateMathLines?: string[] | undefined;
  };
  generated: GeneratorOutput;
  citations: Citation[];
  decisionLog: DecisionLogEntry[] | undefined;
  collected: VerifyStageArgs['collected'];
  decisionCtx: DecisionContext;
}

export interface AuditedAnswer {
  verdict: VerifierOutput;
  generated: GeneratorOutput;
  citations: Citation[];
  decisionLog: DecisionLogEntry[] | undefined;
}

/**
 * The audit stage of the primary serve: the verifier (plus the MM-zoom
 * step, fragment-zoom-seam.ts) over the generated answer, then the
 * revision round on a partial verdict. Returns the answer that will be
 * served with the verdict that judged it — the primary pair when no
 * revision ran, the rewrite and its verdict when one did. The auditor
 * reads the same "today" the generator was given (dateContext), so
 * calendar placement is judged, not flagged.
 */
export async function auditAndRevise(
  ports: AuditPorts,
  args: AuditArgs,
): Promise<AuditedAnswer | { failed: SynthesizeResult }> {
  const { ctx, round } = args;
  const { dto, profile, guardrails } = ctx;
  const verifyArgs: Omit<VerifyStageArgs, 'onPrimaryVerdict'> = {
    ctx,
    generated: args.generated,
    collected: args.collected,
    promptFactLines: round.promptFactLines,
    dateMathLines: round.dateMathLines,
    dateContext: resolveLaneDateContext(profile, args.lane, dto.asOf),
    citations: args.citations,
    results: round.results,
    decisionLog: args.decisionLog,
    factCount: round.factIndex.size,
    decisionCtx: args.decisionCtx,
  };
  const verified = await verifyAndZoom(ports.verifyDeps, {
    ...verifyArgs,
    onPrimaryVerdict: (v) =>
      ports.captureFocus(
        ctx.companyId,
        {
          results: round.results,
          verdict: v.verdict,
          lane: args.lane,
          decisionId: args.decisionCtx.primaryDecisionId,
        },
        dto.query,
      ),
  });
  if ('failed' in verified) return { failed: verified.failed };
  const primary: AuditedAnswer = {
    verdict: verified.verdict,
    generated: args.generated,
    citations: args.citations,
    decisionLog: args.decisionLog,
  };
  const revised = await reviseUnsupported(ports, {
    verdict: primary.verdict,
    generated: primary.generated,
    nliMode: guardrails === 'lenient' && profile.abstentionCalibration === 'minicheck',
    regenerate: (revise) =>
      ports.generate(
        buildGeneratorArgs(args.produceArgs, {
          results: round.results,
          promptFactLines: round.promptFactLines,
          factIndex: round.factIndex,
          dateMathLines: round.dateMathLines,
          revise,
        }),
      ),
    reverify: (g) =>
      verifyAndZoom(ports.verifyDeps, {
        ...verifyArgs,
        generated: g,
        citations: resolveCitations(g.citedFactIds, g.answer, round.factIndex),
        onPrimaryVerdict: async () => undefined,
      }),
  });
  if (!revised) return primary;
  const citations = resolveCitations(
    revised.generated.citedFactIds,
    revised.generated.answer,
    round.factIndex,
  );
  return {
    verdict: revised.verdict,
    generated: revised.generated,
    citations,
    decisionLog: args.explain
      ? buildDecisionLog(round.results, new Set(citations.map((c) => c.factId)))
      : undefined,
  };
}
