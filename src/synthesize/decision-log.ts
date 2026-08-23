/**
 * DecisionLog — per-fact reasoning trace returned alongside a synthesized
 * answer. The shape follows the W3C PROV-O / OpenTelemetry GenAI
 * convention: each entry attributes a retrieved fact to the activity
 * that surfaced it (`provActivity`), exposes the multiplicative score
 * components that placed it (`scoreBreakdown`), and records whether the
 * synthesizer cited it (`picked`) plus a brief rejection reason if not.
 *
 * Pure module — no DI, no IO, no logger. The synthesize service calls
 * `buildDecisionLog()` after the generator emits its citations and
 * before returning the response.
 *
 * Phase 1 scope:
 *  - per-fact scoring breakdown (fusedScore × decay × confidence)
 *  - retrieval-stage provenance (vector | lexical | graph_seed | graph_neighbour
 *    | edge_expansion | ppr)
 *  - cited vs not-cited classification with deterministic rejection
 *    reason (no LLM judge — see PROV-AGENT 2025 / Attributing Response
 *    to Context arXiv:2505.16415: post-hoc LLM judgements are unfaithful)
 *
 * Phase 2 will extend this with `conflictExplanation` when a fact was
 * superseded; Phase 3 with `calibratedConfidence` and conformal
 * p-values. The shape stays additive — existing fields never change
 * meaning between phases.
 */

import type { SearchHit } from '../search/search.types';
import type { ScoreBreakdown } from '../search/internals/types';

export type DecisionRejectReason =
  | 'low_score'
  | 'not_relevant_to_query'
  | 'duplicate_predicate';

export interface DecisionLogEntry {
  factId: string;
  entityId: string;
  canonicalName: string;
  predicate: string;
  object: string;
  /** True iff the synthesizer's generator emitted [fid:...] for this fact. */
  picked: boolean;
  /** Populated only when `picked === false`. Deterministic, template-derived. */
  rejectReason?: DecisionRejectReason | undefined;
  /** All multiplicative score components that placed the fact. */
  scoreBreakdown: ScoreBreakdown;
}

/**
 * Build the DecisionLog from the retrieved set and the generator's
 * cited factId list.
 *
 *   - `picked = citedFactIds.has(factId)`
 *   - `rejectReason` is derived from scoreBreakdown semantics:
 *       * finalScore < lowScoreThreshold              → low_score
 *       * else                                        → not_relevant_to_query
 *
 * The threshold is config-injected so future calibration changes don't
 * silently shift rejection labels. Default 0.1 — chosen so that hits
 * scaled by decay/confidence don't get tagged "low_score" purely
 * because of long-tail recency.
 */
export interface BuildDecisionLogOptions {
  /** finalScore below this threshold → reject reason = 'low_score'. */
  lowScoreThreshold?: number;
}

export function buildDecisionLog(
  hits: SearchHit[],
  citedFactIds: ReadonlySet<string>,
  opts: BuildDecisionLogOptions = {},
): DecisionLogEntry[] {
  const lowScoreThreshold = opts.lowScoreThreshold ?? 0.1;
  const entries: DecisionLogEntry[] = [];
  const seenPredicatesByEntity = new Map<string, Set<string>>();

  for (const hit of hits) {
    let predicateSet = seenPredicatesByEntity.get(hit.entityId);
    if (!predicateSet) {
      predicateSet = new Set();
      seenPredicatesByEntity.set(hit.entityId, predicateSet);
    }

    for (const f of hit.facts) {
      const breakdown =
        f.breakdown ??
        ({
          fusedScore: f.score,
          confidence: f.confidence,
          decay: 1,
          finalScore: f.score,
          stages: [],
        } as ScoreBreakdown);
      const picked = citedFactIds.has(f.factId);
      const duplicatePredicate = predicateSet.has(f.predicate);
      predicateSet.add(f.predicate);

      const rejectReason: DecisionRejectReason | undefined = picked
        ? undefined
        : duplicatePredicate
          ? 'duplicate_predicate'
          : breakdown.finalScore < lowScoreThreshold
            ? 'low_score'
            : 'not_relevant_to_query';

      entries.push({
        factId: f.factId,
        entityId: hit.entityId,
        canonicalName: hit.canonicalName,
        predicate: f.predicate,
        object: f.object,
        picked,
        rejectReason,
        scoreBreakdown: breakdown,
      });
    }
  }

  // Stable ordering: picked first (in finalScore-desc), then rejected
  // (also finalScore-desc). The caller renders this top-down.
  return entries.sort((a, b) => {
    if (a.picked !== b.picked) return a.picked ? -1 : 1;
    return b.scoreBreakdown.finalScore - a.scoreBreakdown.finalScore;
  });
}
