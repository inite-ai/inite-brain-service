import { MemoryOutcomeService, type OutcomeEventInput } from '../outcomes/memory-outcome.service';
import type { Citation } from './fact-index';
import type { VerifierOutput } from './verifier';
import { unverifiedReturn, type VerdictDeps } from './verdict';
import type { EvidenceCitation, SynthesizeResult } from './synthesize.types';

/**
 * Outcome telemetry (0107) emit seams for the synthesize orchestrator,
 * extracted from the service (file/function budgets). Every function is
 * a guarded no-op unless the outcomes module is wired AND the master
 * flag is on — checked through the service STATIC so this engine dir
 * takes resolved config only and never reads the environment directly
 * (engine-gates S5.2, the FocusSignalService.captureEnabled() idiom).
 * The service detaches the write (root pool, fire-and-forget), so
 * serving never waits on telemetry, and a telemetry failure can never
 * fail an answer.
 */

/**
 * The facts that made the FINAL prompt evidence set (post search-loop
 * refine) were selected for context — emitted once per request, at the
 * one point the set is final.
 */
export function emitSelectedForContext(
  outcomes: MemoryOutcomeService | undefined,
  companyId: string,
  factIds: Iterable<string>,
): void {
  if (!outcomes || !MemoryOutcomeService.enabled()) return;
  const events: OutcomeEventInput[] = [...factIds].map((id) => ({
    subjectKind: 'fact',
    subjectId: id,
    event: 'selected_for_context',
  }));
  if (events.length === 0) return;
  outcomes.recordOutcomes({ companyId, events });
}

/**
 * The unverifiedReturn exit (verdict.ts) plus its 0107 emission, one
 * seam: guardrails 'off'/'answer' serve citations with NO verifier —
 * that counts as use, never as verified use (no verifier_supported by
 * design), and the refusal exit carries citations: [] → zero events.
 * Null falls through to the verifier path exactly as before.
 */
export function unverifiedServe(
  deps: VerdictDeps & { outcomes?: MemoryOutcomeService | undefined },
  companyId: string,
  args: Parameters<typeof unverifiedReturn>[1],
): SynthesizeResult | null {
  const result = unverifiedReturn(deps, args);
  if (result) emitAnswerUse(deps.outcomes, { companyId, citations: result.citations });
  return result;
}

/**
 * The cited facts were used in the answer; on a `supported` verdict the
 * same ids additionally count as VERIFIED use (meta carries the verdict
 * string only — content-free). Called from BOTH finalizeAndAdmit
 * serving paths (primary + L3 flip) with the verdict, and from the
 * unverifiedReturn exit WITHOUT one — guardrails off/'answer' serve
 * citations with no verifier, which counts as use, never as verified
 * use. `companyId` is optional because bare-cache finalize callers may
 * not carry it — absent ⇒ no events.
 */
export function emitAnswerUse(
  outcomes: MemoryOutcomeService | undefined,
  opts: {
    companyId: string | undefined;
    citations: Citation[];
    verdict?: VerifierOutput;
    /**
     * 0119: the request's primary decision id (abstain gate or L3
     * trigger), threaded by synthesize ONLY under
     * OUTCOME_DECISION_CAPTURE — absent ⇒ rows byte-identical.
     */
    decisionId?: string | undefined;
  },
): void {
  const { companyId, citations, verdict, decisionId } = opts;
  if (!outcomes || !MemoryOutcomeService.enabled() || companyId === undefined) return;
  const events: OutcomeEventInput[] = citations.map((c) => ({
    subjectKind: 'fact',
    subjectId: c.factId,
    event: 'used_in_answer',
    ...(decisionId !== undefined ? { decisionId } : {}),
  }));
  if (verdict?.verdict === 'supported') {
    events.push(
      ...citations.map((c): OutcomeEventInput => ({
        subjectKind: 'fact',
        subjectId: c.factId,
        event: 'verifier_supported',
        meta: { verdict: verdict.verdict },
        ...(decisionId !== undefined ? { decisionId } : {}),
      })),
    );
  }
  if (events.length === 0) return;
  outcomes.recordOutcomes({ companyId, events });
}

/**
 * BELIEFS_SERVING_LANE (D7): the belief lines rendered into the prompt
 * were selected for context — emitted once per request, right after the
 * collector returns (the rendered set is final there: the search-loop
 * refine never re-runs the belief lane). subjectKind 'belief' rides the
 * existing 0107 vocabulary — no schema work.
 */
export function emitBeliefContext(
  outcomes: MemoryOutcomeService | undefined,
  companyId: string,
  beliefIds: Iterable<string>,
): void {
  if (!outcomes || !MemoryOutcomeService.enabled()) return;
  const events: OutcomeEventInput[] = [...beliefIds].map((id) => ({
    subjectKind: 'belief',
    subjectId: id,
    event: 'selected_for_context',
  }));
  if (events.length === 0) return;
  outcomes.recordOutcomes({ companyId, events });
}

/**
 * BELIEFS_SERVING_LANE (D7): the belief-arm evidence citations of a
 * served answer count as use — `used_in_answer`, plus `verifier_supported`
 * on a supported verdict, the 0119 decisionId threaded exactly like the
 * fact arm (emitAnswerUse above). Called from finalizeAndAdmit — BOTH
 * serving paths land there; the L3 flip carries episode-arm citations
 * only, so the belief filter yields zero events on that path today.
 * Non-belief arms (episodeId / fragmentId) are skipped by the filter.
 */
export function emitBeliefAnswerUse(
  outcomes: MemoryOutcomeService | undefined,
  opts: {
    companyId: string | undefined;
    evidenceCitations: EvidenceCitation[] | undefined;
    verdict?: VerifierOutput;
    decisionId?: string | undefined;
  },
): void {
  const { companyId, evidenceCitations, verdict, decisionId } = opts;
  if (!outcomes || !MemoryOutcomeService.enabled() || companyId === undefined) return;
  const beliefIds = (evidenceCitations ?? [])
    .map((c) => c.beliefId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const events: OutcomeEventInput[] = beliefIds.map((id) => ({
    subjectKind: 'belief',
    subjectId: id,
    event: 'used_in_answer',
    ...(decisionId !== undefined ? { decisionId } : {}),
  }));
  if (verdict?.verdict === 'supported') {
    events.push(
      ...beliefIds.map((id): OutcomeEventInput => ({
        subjectKind: 'belief',
        subjectId: id,
        event: 'verifier_supported',
        meta: { verdict: verdict.verdict },
        ...(decisionId !== undefined ? { decisionId } : {}),
      })),
    );
  }
  if (events.length === 0) return;
  outcomes.recordOutcomes({ companyId, events });
}
