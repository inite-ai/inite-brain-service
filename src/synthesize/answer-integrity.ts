import type OpenAI from 'openai';
import type { MetricsService } from '../metrics/metrics.service';
import type { Semaphore } from '../common/semaphore';
import type { AnswerCacheBeginResult } from '../answer-cache/answer-cache.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesizeDto } from './dto/synthesize.dto';
import { plausibilityCheckEnabled, requireCitationsEnabled } from '../common/fovea-flags';
import type { Citation } from './fact-index';
import { runPlausibilityJudge, type VerifierOutput } from './verifier';

/**
 * Verifier answer-integrity arm (docs/roadmap/fovea-optics-2026-08.md +
 * docs/roadmap/memtrap-shakedown-2026-08.md) — the two default-off,
 * post-grounding guards on a SUPPORTED verdict, resolved off the engine's
 * env-read boundary (the flag reads live in common/fovea-flags; this module
 * performs no direct env reads, engine-gates S5.2) and threaded into
 * finalizeVerdict. BOTH off ⇒ empty object ⇒ finalizeVerdict byte-identical.
 */
export interface AnswerIntegrityDeps {
  openai: OpenAI;
  metrics?: MetricsService | undefined;
  logger: { warn(message: string): void };
  /** The synthesize concurrency limiter — the plausibility judge runs on it,
   *  exactly like the verifier call. */
  limiter: Pick<Semaphore, 'run'>;
}

/**
 * The finalize context handed to finalizeAndAdmit. `dto`+`profile` are present
 * on BOTH serving paths — the primary serve AND the L3 fail-flip — so both
 * resolve the answer-integrity arm. (Historically the L3 path passed just
 * `cache` and bypassed the gate; it now carries dto/profile/model so its
 * raw-transcript answer — the most exposed to belief distortion and to uncited
 * "supported" answers — is gated end-to-end. `cache`-only remains supported and
 * simply yields an empty gate.)
 */
export interface FinalizeContext {
  cache: AnswerCacheBeginResult | undefined;
  dto?: SynthesizeDto | undefined;
  profile?: RetrievalProfile | undefined;
  model?: string | undefined;
}

/**
 * Resolve the Part A + Part C gate flags for finalizeVerdict. Returns an empty
 * object — no LLM call — unless the caller supplied dto+profile AND the verdict
 * is `supported`. Both the primary serve and the L3 flip supply dto+profile, so
 * both are gated. Part C (FOVEA_REQUIRE_CITATIONS) is a pure flag; Part A
 * (FOVEA_PLAUSIBILITY_CHECK) runs ONE extra LLM plausibility judge over the
 * cited premises (see resolvePlausibilityDowngrade). The auditor model is
 * profile.verifierModel || the synthesis model.
 *
 * Consequence on L3: an L3 answer that grounds on the raw transcript may be
 * UNCITED by design ("claims from transcript need no citation"). With
 * FOVEA_REQUIRE_CITATIONS on, such an answer therefore abstains — the correct
 * end-to-end reading of the citation-bearing promise. An operator enabling
 * require-citations is explicitly opting into "no uncited answers, including
 * L3". (Default-off, so no prod impact.)
 *
 * NOTE on the serving-cost boundary: the judge fires on a `supported` verdict
 * when the flag is on and cited premises exist. In the narrow lenient +
 * abstentionCalibration='verifier' + verifierTopicCoverage config where
 * questionAnswered=false already abstains, finalizeVerdict abstains on that
 * condition first, so the judge call there is redundant (correct result, one
 * extra call in that config only).
 */
export async function resolveAnswerIntegrity(
  deps: AnswerIntegrityDeps,
  input: {
    ctx: FinalizeContext;
    verdict: VerifierOutput;
    args: { answer: string; citations: Citation[] };
    defaultModel: string;
  },
): Promise<{ plausibilityDowngrade?: boolean; requireCitations?: boolean }> {
  const { ctx } = input;
  if (!ctx.dto || !ctx.profile || input.verdict.verdict !== 'supported') return {};
  const requireCitations = requireCitationsEnabled();
  const plausibilityDowngrade = await resolvePlausibilityDowngrade(deps, {
    query: ctx.dto.query,
    answer: input.args.answer,
    citations: input.args.citations,
    model: ctx.profile.verifierModel || ctx.model || input.defaultModel,
  });
  return {
    ...(plausibilityDowngrade ? { plausibilityDowngrade } : {}),
    ...(requireCitations ? { requireCitations } : {}),
  };
}

/**
 * Part A (FOVEA_PLAUSIBILITY_CHECK): run the post-grounding plausibility judge
 * over the CITED premises and return whether the supported answer should be
 * DOWNGRADED to an abstain. Off ⇒ false with NO LLM call (byte-identical). The
 * judge audits the cited premise's trustworthiness, so with zero cited
 * premises there is nothing to judge (Part C owns the zero-citation case) →
 * false, no call. A judge error FAILS SAFE to today's behavior (no downgrade)
 * and is logged — a transient LLM error must not turn a grounded answer into
 * an abstain.
 */
async function resolvePlausibilityDowngrade(
  deps: AnswerIntegrityDeps,
  input: { query: string; answer: string; citations: Citation[]; model: string },
): Promise<boolean> {
  if (!plausibilityCheckEnabled()) return false;
  const citedPremises = input.citations.map(
    (c) => `${c.canonicalName} — ${c.predicate}: ${c.object}`,
  );
  if (citedPremises.length === 0) return false;
  try {
    const out = await deps.limiter.run(() =>
      runPlausibilityJudge({
        openai: deps.openai,
        metrics: deps.metrics,
        query: input.query,
        answer: input.answer,
        citedPremises,
        model: input.model,
      }),
    );
    return !out.plausible;
  } catch (e) {
    deps.logger.warn(
      `plausibility judge failed; serving as grounded (no downgrade): ${(e as Error).message}`,
    );
    return false;
  }
}
