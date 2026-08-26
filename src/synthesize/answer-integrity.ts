import type OpenAI from 'openai';
import type { MetricsService } from '../metrics/metrics.service';
import type { Semaphore } from '../common/semaphore';
import type { AnswerCacheBeginResult } from '../answer-cache/answer-cache.service';
import type { PredicateRegistryService } from '../ai/predicate-registry.service';
import type { RetrievalProfile } from '../search/retrieval-profile';
import type { SynthesizeDto } from './dto/synthesize.dto';
import {
  evidenceCapabilityEnabled,
  plausibilityCheckEnabled,
  requireCitationsEnabled,
} from '../common/fovea-flags';
import type { Citation } from './fact-index';
import type { EvidenceCapability, EvidenceCitation } from './synthesize.types';
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
  /**
   * Tenant for the 0107 outcome-telemetry writer inside finalizeAndAdmit
   * (used_in_answer / verifier_supported). Both serving paths — the
   * primary serve and the L3 flip — carry it; absent (bare-cache
   * callers) ⇒ no events, like the empty integrity gate.
   */
  companyId?: string | undefined;
}

/**
 * Resolve the Part A + Part C gate flags for finalizeVerdict, plus the
 * evidence-capability flag (FOVEA_EVIDENCE_CAPABILITY, 0113 — composed from
 * resolveEvidenceCapability below so finalizeAndAdmit keeps ONE gate call).
 * Returns an empty object — no LLM call, no registry lookup — on a
 * non-supported verdict; A + C additionally require dto+profile. Both the
 * primary serve and the L3 flip supply dto+profile, so both are gated. Part C
 * (FOVEA_REQUIRE_CITATIONS) is a pure flag; Part A
 * (FOVEA_PLAUSIBILITY_CHECK) runs ONE extra LLM plausibility judge over the
 * cited premises (see resolvePlausibilityDowngrade). The auditor model is
 * profile.verifierModel || the synthesis model.
 *
 * Consequence on L3 (with FOVEA_L3_EPISODE_CITATIONS off): an L3 answer that
 * grounds on the raw transcript may be UNCITED by design ("claims from
 * transcript need no citation"). With FOVEA_REQUIRE_CITATIONS on, such an
 * answer therefore abstains — the correct end-to-end reading of the
 * citation-bearing promise. An operator enabling require-citations is
 * explicitly opting into "no uncited answers, including L3". With
 * FOVEA_L3_EPISODE_CITATIONS ALSO on, transcript-grounded claims carry
 * episode-level evidence citations instead, and the finalizeVerdict guard
 * counts those: an episode-cited L3 answer SERVES under require-citations
 * (verdict.ts). (All default-off, so no prod impact.)
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
    args: {
      answer: string;
      citations: Citation[];
      evidenceCitations?: EvidenceCitation[] | undefined;
    };
    defaultModel: string;
    /**
     * Evidence-capability gate (FOVEA_EVIDENCE_CAPABILITY, 0113): the
     * per-predicate policy source, threaded from the service's @Optional
     * injection. Absent (trimmed fixtures) ⇒ the capability arm is a
     * guarded no-op, like an off flag.
     */
    registry?: Pick<PredicateRegistryService, 'rowPolicyLookup'> | undefined;
  },
): Promise<{
  plausibilityDowngrade?: boolean;
  requireCitations?: boolean;
  evidenceCapabilityUnmet?: boolean;
}> {
  const { ctx } = input;
  if (input.verdict.verdict !== 'supported') return {};
  // The capability arm needs only companyId + registry (both serving
  // paths carry dto/profile/companyId anyway; bare-cache callers lack
  // companyId and no-op inside the resolver).
  const capability = await resolveEvidenceCapability(
    { registry: input.registry, metrics: deps.metrics, logger: deps.logger },
    {
      ctx,
      verdict: input.verdict,
      citations: input.args.citations,
      evidenceCitations: input.args.evidenceCitations,
    },
  );
  if (!ctx.dto || !ctx.profile) return capability;
  const requireCitations = requireCitationsEnabled();
  const plausibilityDowngrade = await resolvePlausibilityDowngrade(deps, {
    query: ctx.dto.query,
    answer: input.args.answer,
    citations: input.args.citations,
    model: ctx.profile.verifierModel || ctx.model || input.defaultModel,
  });
  return {
    ...capability,
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
 * an abstain. The judge audits FACT citations only — L3 episode evidence
 * citations are verbatim-verified mechanically by anchorQuote and carry no
 * premise to audit.
 */
/**
 * Evidence-capability gate deps (FOVEA_EVIDENCE_CAPABILITY, 0113). The
 * registry arrives @Optional from the service — absent (trimmed unit
 * fixtures) ⇒ the resolver is a guarded no-op, like an off flag.
 */
export interface EvidenceCapabilityDeps {
  registry?: Pick<PredicateRegistryService, 'rowPolicyLookup'> | undefined;
  metrics?: Pick<MetricsService, 'countEvidenceCapability'> | undefined;
  logger: { warn(message: string): void };
}

/**
 * "max over cited facts": severity order for the required-capability fold.
 * 'text' is the floor (unconstrained); ANY non-text requirement outranks
 * it and forces the gate. The relative order among non-text kinds is a
 * deterministic tie-break only — with today's all-text cited set every
 * non-text requirement abstains identically; the order starts mattering
 * once the M-track fragment mapping supplies non-text cited capabilities.
 */
const CAPABILITY_RANK: Record<EvidenceCapability, number> = {
  text: 0,
  visual: 1,
  audio: 2,
  document_region: 3,
};

/**
 * Resolve the evidence-capability gate flag for finalizeVerdict — the
 * resolveAnswerIntegrity sibling in the finalizeAndAdmit gate-resolution.
 * Flag off ⇒ {} with NO registry lookup (byte-identical, the
 * answer-integrity precedent); likewise for a non-supported verdict, a
 * bare-cache caller (no companyId), a trimmed fixture (no registry), or
 * zero cited facts (Part C owns the uncited case).
 *
 * Flag on: ONE snapshot-warm (rowPolicyLookup — TTL-cached, herd-deduped)
 * then sync per-citation lookups against the tenant registry — no per-fact
 * IO. required = max over the cited facts' predicate policies (any
 * non-text wins); the cited-capability set today is always {'text'}
 * (facts + episode spans are text), so the check can only abstain or
 * pass. Once the operator enables this integrity gate, a lookup failure
 * FAILS CLOSED: without predicate policy the system cannot prove that text
 * evidence is sufficient, so availability must not silently erase the
 * modality requirement.
 */
export async function resolveEvidenceCapability(
  deps: EvidenceCapabilityDeps,
  input: {
    ctx: FinalizeContext;
    verdict: VerifierOutput;
    citations: Citation[];
    evidenceCitations?: EvidenceCitation[] | undefined;
  },
): Promise<{ evidenceCapabilityUnmet?: boolean }> {
  if (!evidenceCapabilityEnabled()) return {};
  const { ctx, verdict, citations } = input;
  if (verdict.verdict !== 'supported') return {};
  if (!ctx.companyId || !deps.registry || citations.length === 0) return {};
  try {
    const policyFor = await deps.registry.rowPolicyLookup(ctx.companyId);
    const required = citations.reduce<EvidenceCapability>((acc, c) => {
      const cap = policyFor(c.predicate).requiredEvidenceCapability ?? 'text';
      return CAPABILITY_RANK[cap] > CAPABILITY_RANK[acc] ? cap : acc;
    }, 'text');
    deps.metrics?.countEvidenceCapability('checked');
    if (required === 'text') return {};
    if (citedCapabilities(input.evidenceCitations).has(required)) return {};
    return { evidenceCapabilityUnmet: true };
  } catch (e) {
    deps.metrics?.countEvidenceCapability('checked');
    deps.logger.warn(
      `evidence-capability resolution failed; failing closed: ${(e as Error).message}`,
    );
    return { evidenceCapabilityUnmet: true };
  }
}

/**
 * The capabilities the answer's cited evidence actually carries.
 *
 * SEAM (M-track fragment mapping): today EVERY citation is text — fact
 * citations are extracted text lines and EvidenceCitation is an
 * episode/span over stored turn TEXT — so this is the constant {'text'}
 * and the gate is honestly abstain-or-pass. The M-track sibling maps
 * media fragments into citations carrying their own capability kind;
 * it extends THIS function (and populates
 * VerifyRequest.capabilityEvidenceLines) — nothing else in the gate
 * changes.
 */
function citedCapabilities(
  _evidenceCitations: EvidenceCitation[] | undefined,
): Set<EvidenceCapability> {
  return new Set<EvidenceCapability>(['text']);
}

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
