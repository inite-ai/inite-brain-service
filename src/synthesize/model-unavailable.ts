import type { SynthesisGuardrails } from './dto/synthesize.dto';
import type { SearchHit } from '../search/search.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { DecisionLogEntry } from './decision-log';
import type { Citation } from './fact-index';
import type { SynthesisDegradation, SynthesizeResult } from './synthesize.types';
import { attachDecisionLog } from './synthesize.helpers';
import {
  classifyProviderFailure,
  PLATFORM_MODELS_NOT_INCLUDED_NOTICE,
  SERVER_MODELS_NOTICE,
  type ServerModelsNotice,
  serverModelsUnavailable,
} from '../ai/provider-failure';
import { HarnessModeRefusal } from '../common/extraction-source';
import { PlatformModelsNotIncluded } from '../common/model-source';
import { TenantBudgetExceeded } from '../ai/tenant-llm-budget';

/**
 * The `model_unavailable` exit (#945 phase 1): the server's model provider
 * refused a stage of the answer — billing, key, quota or outage — so the
 * result says so instead of reading as a verdict on the memory.
 *
 * WHY. On 2026-11-13 the provider answered 402 for hours. `synthesize`
 * returned `verifier_failed` in strict mode and "I don't have that in my
 * memory" (`low_coverage`) in lenient mode, while `off` answered the same
 * question correctly: a provider outage was presented as an absence of
 * memory, and an external tester read it as a false abstention.
 *
 * The shapes:
 *  - `generator`: no answer was produced — `answer: null` in every mode;
 *    `results` still carry the evidence for the caller to answer from.
 *  - `verifier`, strict: fail-closed as strict always is — `answer: null`.
 *  - `verifier`, lenient: the generated answer IS served, with its
 *    citations, tagged `model_unavailable` + `degraded: ['verifier']` +
 *    the notice saying it could not be checked. Lenient is the mode whose
 *    contract is "the answer with the verdict attached" (it already serves
 *    `verifier_partial` and `verifier_error` answers); withholding it here
 *    would turn the outage back into the empty answer the incident was.
 *    Never the "not in memory" text.
 *
 * Never cached: the answer cache admits only reason-less supported results.
 */
export function modelUnavailableResult(
  metrics: Pick<MetricsService, 'countSynthesize'> | undefined,
  args: {
    stage: SynthesisDegradation;
    guardrails: SynthesisGuardrails;
    answer: string | null;
    citations: Citation[];
    results: SearchHit[];
    decisionLog?: DecisionLogEntry[] | undefined;
    notice?: ServerModelsNotice;
  },
): SynthesizeResult {
  metrics?.countSynthesize('model_unavailable');
  const serve = args.stage === 'verifier' && args.guardrails !== 'strict' && args.answer !== null;
  return attachDecisionLog(
    {
      answer: serve ? args.answer : null,
      reason: 'model_unavailable',
      citations: serve ? args.citations : [],
      results: args.results,
      degraded: [args.stage],
      notice: args.notice ?? SERVER_MODELS_NOTICE,
    },
    args.decisionLog,
  );
}

/**
 * The generator threw: no answer is generated, and the reason says why —
 * `harness_mode` (the server spends no key), `model_budget` (the tenant's
 * daily budget is spent), `model_unavailable` (the provider refused —
 * billing, key, quota, outage) or `generator_error` (anything else).
 * `results` carry the evidence the caller answers from. Logs the class of
 * failure and the provider's error message, never the prompt.
 */
export function generatorFailureResult(
  deps: {
    metrics?: Pick<MetricsService, 'countSynthesize'> | undefined;
    logger: { warn(message: string): void };
  },
  args: {
    err: unknown;
    guardrails: SynthesisGuardrails;
    results: SearchHit[];
    decisionLog?: DecisionLogEntry[] | undefined;
  },
): SynthesizeResult {
  const { err, results, decisionLog } = args;
  if (err instanceof PlatformModelsNotIncluded) {
    // The plan has no server-side models (#945 phase 2): the evidence is
    // served and the notice says how the tenant's agent can answer.
    return modelUnavailableResult(deps.metrics, {
      stage: 'generator',
      guardrails: args.guardrails,
      answer: null,
      citations: [],
      results,
      decisionLog,
      notice: PLATFORM_MODELS_NOT_INCLUDED_NOTICE,
    });
  }
  if (err instanceof HarnessModeRefusal || err instanceof TenantBudgetExceeded) {
    const reason = err instanceof HarnessModeRefusal ? 'harness_mode' : 'model_budget';
    deps.metrics?.countSynthesize(reason);
    return attachDecisionLog({ answer: null, reason, citations: [], results }, decisionLog);
  }
  const cls = classifyProviderFailure(err);
  if (serverModelsUnavailable(cls)) {
    deps.logger.warn(`Synthesize generator refused by the provider (${cls}): ${errMessage(err)}`);
    return modelUnavailableResult(deps.metrics, {
      stage: 'generator',
      guardrails: args.guardrails,
      answer: null,
      citations: [],
      results,
      decisionLog,
    });
  }
  deps.logger.warn(`Synthesize generator failed: ${errMessage(err)}`);
  deps.metrics?.countSynthesize('generator_error');
  return attachDecisionLog(
    { answer: null, reason: 'generator_error', citations: [], results },
    decisionLog,
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
