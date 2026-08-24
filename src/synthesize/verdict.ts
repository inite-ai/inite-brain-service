import type { SearchHit } from '../search/search.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { MetricsService } from '../metrics/metrics.service';
import type { SynthesisGuardrails } from './dto/synthesize.dto';
import { buildDecisionLog, type DecisionLogEntry } from './decision-log';
import { assessMemoryCoverage, NOT_IN_MEMORY_ANSWER } from './abstention';
import { attachDecisionLog } from './synthesize.helpers';
import type { Citation } from './fact-index';
import type { GeneratorOutput, SynthesisReason, SynthesizeResult } from './synthesize.types';

/**
 * Verdict → response shaping, split out of synthesize.service.ts (the
 * V10.5 audit pass — file budget headroom before the V11 features).
 * Three pure-ish functions (metrics/logger arrive as deps): the
 * verifier-decision matrix, the two no-verifier exits, and the V9 §4
 * pre-generation coverage floor. The orchestrator keeps thin adapters
 * so its call sites (and the spec bindings) stay unchanged.
 */

export interface VerdictDeps {
  metrics?: Pick<MetricsService, 'countSynthesize'> | undefined;
  logger?: { debug(message: string): void } | undefined;
}

/**
 * Verdict → response shape. Strict + non-supported → answer dropped
 * (fail-closed). Lenient surfaces the answer with a reason tag —
 * except under abstentionCalibration='verifier', where a non-supported
 * verdict (or a supported-but-not-answering judgment, V10 §5) IS the
 * coverage signal and returns the explicit decline. Supported is the
 * ok path.
 */
export function finalizeVerdict(
  deps: VerdictDeps,
  {
    verdict,
    questionAnswered,
    answer,
    citations,
    results,
    guardrails,
    decisionLog,
    abstention,
  }: {
    verdict: 'supported' | 'partial' | 'unsupported';
    questionAnswered?: boolean | undefined;
    answer: string;
    citations: Citation[];
    results: SynthesizeResult['results'];
    guardrails: SynthesisGuardrails;
    decisionLog?: DecisionLogEntry[] | undefined;
    abstention?: RetrievalProfile['abstentionCalibration'] | undefined;
  },
): SynthesizeResult {
  if (verdict === 'supported') {
    // V10 §5: supported-but-not-answering — the V9 abstention residual
    // (fabrications assembled from real facts pass the grounding
    // audit). Only the topic-coverage audit produces the judgment
    // (undefined otherwise), and only the lenient 'verifier'
    // abstention mode consumes it.
    if (guardrails === 'lenient' && abstention === 'verifier' && questionAnswered === false) {
      deps.metrics?.countSynthesize('low_coverage');
      return attachDecisionLog(
        {
          answer: NOT_IN_MEMORY_ANSWER,
          reason: 'low_coverage',
          citations: [],
          results,
        },
        decisionLog,
      );
    }
    deps.metrics?.countSynthesize('ok');
    return attachDecisionLog({ answer, citations, results }, decisionLog);
  }
  // V9 §4 'verifier' abstention: the verifier's verdict IS the
  // coverage signal — an unsupported/partial answer means the memory
  // does not support what was asked, so a lenient caller gets the
  // explicit decline instead of ungrounded text. The V11 §2
  // 'minicheck' arm shares the gate — only the judge differs (local
  // NLI verdict mapped onto supported/unsupported upstream).
  if (guardrails === 'lenient' && (abstention === 'verifier' || abstention === 'minicheck')) {
    deps.metrics?.countSynthesize('low_coverage');
    return attachDecisionLog(
      {
        answer: NOT_IN_MEMORY_ANSWER,
        reason: 'low_coverage',
        citations: [],
        results,
      },
      decisionLog,
    );
  }
  const reason: SynthesisReason = verdict === 'partial' ? 'verifier_partial' : 'verifier_failed';
  deps.metrics?.countSynthesize(reason);
  if (guardrails === 'lenient') {
    return attachDecisionLog({ answer, reason, citations, results }, decisionLog);
  }
  // strict — fail closed.
  return attachDecisionLog({ answer: null, reason, citations: [], results }, decisionLog);
}

/**
 * The two no-verifier exits. Sentinel "I don't know" path: the
 * generator was honest about empty grounding — no verify, no cite;
 * skipped in never-abstain mode. Never-abstain/off then return the
 * grounded best-effort answer directly — verifier skipped. Returns
 * null when the verifier should run.
 */
export function unverifiedReturn(
  deps: VerdictDeps,
  {
    guardrails,
    generated,
    citations,
    results,
    decisionLog,
  }: {
    guardrails: SynthesisGuardrails;
    generated: GeneratorOutput;
    citations: Citation[];
    results: SearchHit[];
    decisionLog?: DecisionLogEntry[] | undefined;
  },
): SynthesizeResult | null {
  if (
    guardrails !== 'answer' &&
    generated.answer.trim() === "I don't have grounded evidence for that."
  ) {
    deps.metrics?.countSynthesize('no_grounded_evidence');
    return attachDecisionLog(
      {
        answer: generated.answer,
        reason: 'no_grounded_evidence',
        citations: [],
        results,
      },
      decisionLog,
    );
  }
  if (guardrails === 'off' || guardrails === 'answer') {
    deps.metrics?.countSynthesize('ok');
    return attachDecisionLog(
      {
        answer: generated.answer,
        citations,
        results,
        ...(generated.usage ? { tokenUsage: generated.usage } : {}),
      },
      decisionLog,
    );
  }
  return null;
}

/**
 * V9 §4 memory-coverage abstention: in the modes where abstention is
 * permitted (strict/lenient — 'answer' is a caller-level never-abstain
 * contract), the evidence must clear the coverage floor before we
 * spend a generator call. Returns null when generation should proceed.
 */
export function coverageAbstention(
  deps: VerdictDeps,
  {
    profile,
    guardrails,
    results,
    explain,
  }: {
    profile: RetrievalProfile;
    guardrails: SynthesisGuardrails;
    results: SearchHit[];
    explain: boolean;
  },
): SynthesizeResult | null {
  if (profile.abstentionCalibration !== 'coverage') return null;
  if (guardrails !== 'strict' && guardrails !== 'lenient') return null;
  const coverage = assessMemoryCoverage(results, {
    minTopScore: profile.abstentionMinTopScore,
    minEvidence: profile.abstentionMinEvidence,
  });
  if (coverage.covered) return null;
  deps.logger?.debug(
    `coverage floor abstained (top=${coverage.topScore.toFixed(3)}, ` +
      `facts=${coverage.factCount})`,
  );
  deps.metrics?.countSynthesize('low_coverage');
  return attachDecisionLog(
    {
      answer: NOT_IN_MEMORY_ANSWER,
      reason: 'low_coverage',
      citations: [],
      results,
    },
    explain ? buildDecisionLog(results, new Set()) : undefined,
  );
}
