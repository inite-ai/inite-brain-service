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
  metrics?:
    | Pick<
        MetricsService,
        | 'countSynthesize'
        | 'countAbstainPath'
        | 'countPlausibilityDowngrade'
        | 'countCitationGuardAbstain'
      >
    | undefined;
  logger?: { debug(message: string): void } | undefined;
}

/**
 * Optics §4.2 pre-answer confidence gate
 * (docs/roadmap/fovea-optics-2026-08.md §4.2). When supplied to
 * `coverageAbstention`, the per-class CALIBRATED pre-answer confidence
 * REPLACES the static coverage floor: abstain when confidence < threshold.
 * The service supplies this ONLY when FOVEA_ADAPTIVE_ABSTAIN is on AND a
 * usable per-class PRE-ANSWER calibration model is loaded for the tenant —
 * absent, the static coverage floor runs, byte-identical to today.
 */
export interface AbstainAdaptiveGate {
  /** Calibrated pre-answer focus confidence in [0,1] for this query's class. */
  confidence: number;
  /** Abstain when confidence < threshold (a knob in (0,1]). */
  threshold: number;
}

/**
 * Verdict → response shape. Strict + non-supported → answer dropped
 * (fail-closed). Lenient surfaces the answer with a reason tag —
 * except under abstentionCalibration='verifier', where a non-supported
 * verdict (or a supported-but-not-answering judgment, V10 §5) IS the
 * coverage signal and returns the explicit decline. Supported is the
 * ok path.
 *
 * Verifier answer-integrity arm (default-off, resolved by the service and
 * passed in — this function stays pure): two orthogonal downgrades on the
 * supported serve-path, each byte-identical to today when its input is
 * absent/false.
 *  - Part A `plausibilityDowngrade` (FOVEA_PLAUSIBILITY_CHECK): the
 *    post-grounding plausibility judge flagged the CITED premise as
 *    implausible / out-of-context (belief distortion) — abstain instead of
 *    serving the grounded-but-false answer.
 *  - Part C `requireCitations` (FOVEA_REQUIRE_CITATIONS): a supported answer
 *    carrying ZERO citations (audit F2(b)) is abstained rather than served as
 *    an uncited "supported" answer.
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
    plausibilityDowngrade,
    requireCitations,
  }: {
    verdict: 'supported' | 'partial' | 'unsupported';
    questionAnswered?: boolean | undefined;
    answer: string;
    citations: Citation[];
    results: SynthesizeResult['results'];
    guardrails: SynthesisGuardrails;
    decisionLog?: DecisionLogEntry[] | undefined;
    abstention?: RetrievalProfile['abstentionCalibration'] | undefined;
    /** Part A: the plausibility judge downgraded this supported answer. */
    plausibilityDowngrade?: boolean | undefined;
    /** Part C: abstain a supported answer with zero citations. */
    requireCitations?: boolean | undefined;
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
    // Part A (FOVEA_PLAUSIBILITY_CHECK): grounding passed but the cited
    // premise is not trustworthy — abstain rather than serve the
    // belief-distorted answer. Absent/false ⇒ byte-identical.
    if (plausibilityDowngrade) {
      deps.metrics?.countSynthesize('low_coverage');
      deps.metrics?.countPlausibilityDowngrade();
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
    // Part C (FOVEA_REQUIRE_CITATIONS): a supported answer with zero
    // citations breaks the citation-bearing promise (audit F2(b)) — abstain
    // rather than serve an uncited "supported" answer. Off ⇒ byte-identical.
    if (requireCitations && citations.length === 0) {
      deps.metrics?.countSynthesize('low_coverage');
      deps.metrics?.countCitationGuardAbstain();
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
 *
 * Optics §4.2: the eligibility sub-condition is the ONE thing the adaptive
 * gate swaps. With an `adaptive` gate present, the abstain condition becomes
 * "calibrated pre-answer confidence < threshold"; without one, it stays the
 * static "coverage below floor". The swap is confined to that sub-condition
 * — the `abstentionCalibration !== 'coverage'` early return, the guardrails
 * strict/lenient gate, and the abstain-response shape are all unconditional
 * and shared, so flag-off / no-model is byte-identical to the pre-Optics
 * decision. Adaptive abstention only applies where coverage-abstention is
 * already the configured mode; a tenant with abstention off is untouched.
 */
export function coverageAbstention(
  deps: VerdictDeps,
  {
    profile,
    guardrails,
    results,
    explain,
    adaptive,
  }: {
    profile: RetrievalProfile;
    guardrails: SynthesisGuardrails;
    results: SearchHit[];
    explain: boolean;
    adaptive?: AbstainAdaptiveGate | undefined;
  },
): SynthesizeResult | null {
  if (profile.abstentionCalibration !== 'coverage') return null;
  if (guardrails !== 'strict' && guardrails !== 'lenient') return null;
  const coverage = assessMemoryCoverage(results, {
    minTopScore: profile.abstentionMinTopScore,
    minEvidence: profile.abstentionMinEvidence,
  });
  // The eligibility swap: adaptive present → confidence < threshold; absent
  // → the static coverage floor (identical to today).
  const shouldAbstain = adaptive ? adaptive.confidence < adaptive.threshold : !coverage.covered;
  if (!shouldAbstain) return null;
  deps.logger?.debug(
    adaptive
      ? `adaptive coverage abstained (conf=${adaptive.confidence.toFixed(3)} < ` +
          `thr=${adaptive.threshold.toFixed(3)})`
      : `coverage floor abstained (top=${coverage.topScore.toFixed(3)}, ` +
          `facts=${coverage.factCount})`,
  );
  // The abstain OUTCOME series is unchanged (kept firing on every abstain);
  // the NEW path counter records which sub-condition decided.
  deps.metrics?.countSynthesize('low_coverage');
  deps.metrics?.countAbstainPath(adaptive ? 'adaptive' : 'static');
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
