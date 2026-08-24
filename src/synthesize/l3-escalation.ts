import { assessMemoryCoverage } from './abstention';
import type { SearchHit } from '../search/search.service';
import type { VerifierOutput } from './verifier';

/**
 * G2 L3 escalation — the pure decision core, split out of the service
 * (docs/roadmap/sota-gap-build-2026-08.md). No IO, no DI, no env: the
 * trigger matrix (the loop-proof monotone invariant), the session
 * selection ranking (fact-hit density + optional temporal overlap), and
 * the flip test. Unit-tested in isolation; the service owns only the IO
 * (session fetch, generation, verification, telemetry).
 */

/** Why the ladder did or did not fire. Only 'fire' escalates. */
export type L3TriggerReason =
  | 'fire'
  | 'skip_already_escalated'
  | 'skip_flag_off'
  | 'skip_verdict_ok'
  | 'skip_covered'
  | 'skip_confident'
  | 'skip_no_refine';

/**
 * Optics-2 confidence gate (docs/roadmap/fovea-optics-2026-08.md §4.1).
 * When supplied, the per-class CALIBRATED confidence REPLACES the static
 * coverage<floor sub-condition of the trigger: escalate only when
 * confidence < threshold. The service supplies this ONLY when
 * FOVEA_ADAPTIVE_L3 is on AND a usable per-class calibration model is
 * loaded for the tenant — absent, the static coverage path runs, which is
 * byte-identical to pre-Optics-2 L3.
 */
export interface L3AdaptiveGate {
  /** Calibrated focus confidence in [0,1] for this query's class. */
  confidence: number;
  /** Escalate when confidence < threshold (a knob in (0,1]). */
  threshold: number;
}

export interface L3TriggerInput {
  /** profile.l3Escalation. */
  l3Escalation: boolean;
  verdict: VerifierOutput['verdict'];
  /** V10 §5 topic-coverage judgment, when the audit produced it. */
  questionAnswered?: boolean | undefined;
  /** Coverage floor result over the retrieved evidence (below floor →
   *  covered=false, the escalation-eligible state). Consulted only on the
   *  STATIC path (when `adaptive` is absent). */
  covered: boolean;
  /** Whether the one search-loop refine round already ran this request. */
  refineAttempted: boolean;
  /** profile.searchLoop — when on, a refine must precede escalation. */
  searchLoop: boolean;
  /**
   * The monotone guard: a tier already escalated this request. The flow
   * is single-shot so this is normally false at the one call site, but
   * modelling it explicitly is the loop-proof invariant — an already-
   * escalated state goes straight to abstain, never re-enters.
   */
  escalated: boolean;
  /**
   * Optics-2 (§4.1) adaptive gate. When set, it REPLACES the static
   * `covered` sub-condition (escalate iff confidence < threshold); when
   * absent, the static coverage floor runs. EVERYTHING else — the
   * monotone `escalated` guard, the flag, the verdict-fail gate, the
   * refine ordering, and (in the service) the anchor requirement — is
   * unconditional and identical across both paths.
   */
  adaptive?: L3AdaptiveGate | undefined;
}

/**
 * The trigger matrix. Fires only when the fact-grounded answer failed
 * (verifier unsupported/partial, OR the supported-but-not-answering
 * abstain-intent) AND the escalation-eligibility sub-condition holds AND a
 * refine already ran (or the search loop is off) AND nothing escalated
 * yet. Any other combination stays on the normal abstention path.
 *
 * The eligibility sub-condition is the ONE thing Optics-2 (§4.1) swaps:
 * with an `adaptive` gate present, it becomes "calibrated confidence below
 * threshold"; without one, it stays the static "coverage below floor".
 * The swap is confined to this sub-condition — every safety guard around
 * it is shared by both paths, so flag-off / no-model is byte-identical to
 * the pre-Optics-2 decision.
 */
export function l3TriggerDecision(input: L3TriggerInput): L3TriggerReason {
  if (input.escalated) return 'skip_already_escalated';
  if (!input.l3Escalation) return 'skip_flag_off';
  const verdictFail = input.verdict !== 'supported' || input.questionAnswered === false;
  if (!verdictFail) return 'skip_verdict_ok';
  if (input.adaptive) {
    // Adaptive path: the calibrated-confidence floor replaces coverage.
    // A confident answer (conf ≥ threshold) is NOT escalation-eligible.
    if (input.adaptive.confidence >= input.adaptive.threshold) return 'skip_confident';
  } else if (input.covered) {
    // Static path: coverage < floor is required — escalation addresses the
    // residual where the extracted facts are thin, not where a well-covered
    // set merely phrased the answer past the auditor.
    return 'skip_covered';
  }
  if (input.searchLoop && !input.refineAttempted) return 'skip_no_refine';
  return 'fire';
}

/**
 * Optics-2 (§4.1) depth scaling: map the confidence deficit below the
 * escalate threshold to a session count, ∝ the deficit and BOUNDED by the
 * static `maxSessions` cap. Lower confidence → more sessions; the result
 * is always in [1, maxSessions].
 *
 *   nSessions = clamp(ceil((threshold − confidence) / threshold · maxSessions), 1, maxSessions)
 *
 * HARD SAFETY: the output can only REDISTRIBUTE depth WITHIN the existing
 * budget — it never exceeds the static `l3MaxSessions` cap and never drops
 * below one, so the adaptive path is never more resource-aggressive than
 * static. A degenerate threshold (≤0, cannot scale) falls back to the full
 * — still capped — budget rather than dividing by zero.
 */
export function adaptiveL3SessionCount(args: {
  confidence: number;
  threshold: number;
  maxSessions: number;
}): number {
  const cap = Math.max(1, Math.floor(args.maxSessions));
  if (!(args.threshold > 0)) return cap;
  const deficit = (args.threshold - args.confidence) / args.threshold;
  const scaled = Math.ceil(deficit * cap);
  if (scaled < 1) return 1;
  if (scaled > cap) return cap;
  return scaled;
}

/** Coverage-floor helper bound to the profile knobs (reuses the V9 §4
 *  signal so the L3 gate reads the SAME coverage the abstention path
 *  does). */
export function l3Covered(
  results: readonly SearchHit[],
  floors: { minTopScore: number; minEvidence: number },
): boolean {
  return assessMemoryCoverage(results, floors).covered;
}

/** Whether an L3 (re-)verification counts as a flip to a servable
 *  answer: supported, and — under topic coverage — actually answering. */
export function verifierPasses(verdict: VerifierOutput, topicCoverage: boolean): boolean {
  if (verdict.verdict !== 'supported') return false;
  if (topicCoverage && verdict.questionAnswered === false) return false;
  return true;
}

/** One anchoring session, resolved from a retrieved fact's grounding
 *  stamp. `score` is the fact-hit score (density tie-break); `atMs` is
 *  the grounding turn's event time (temporal-overlap preference). */
export interface L3SessionAnchor {
  conversationId: string;
  score: number;
  atMs?: number | undefined;
}

/** [from, to) window the query named, for temporal-overlap preference. */
export interface L3Window {
  fromMs: number;
  toMs: number;
}

interface SessionRank {
  conversationId: string;
  hits: number;
  scoreSum: number;
  overlaps: boolean;
}

/**
 * Rank anchoring sessions and return the top `max` conversationIds.
 *
 * Primary key is fact-hit DENSITY (how many retrieved facts ground in
 * that session), tie-broken by summed hit score, then conversationId
 * for determinism. When a query window is supplied (temporal-class
 * questions), sessions whose anchor time falls inside the window sort
 * ahead of those that don't — a rank-only preference, never a filter,
 * so a temporal query with no in-window session still escalates on the
 * densest ones.
 */
export function rankL3Sessions(
  anchors: readonly L3SessionAnchor[],
  opts: { max: number; window?: L3Window | null },
): string[] {
  const bySession = new Map<string, SessionRank>();
  for (const a of anchors) {
    if (!a.conversationId) continue;
    const cur =
      bySession.get(a.conversationId) ??
      ({
        conversationId: a.conversationId,
        hits: 0,
        scoreSum: 0,
        overlaps: false,
      } satisfies SessionRank);
    cur.hits += 1;
    cur.scoreSum += Number.isFinite(a.score) ? a.score : 0;
    if (
      opts.window &&
      typeof a.atMs === 'number' &&
      a.atMs >= opts.window.fromMs &&
      a.atMs < opts.window.toMs
    ) {
      cur.overlaps = true;
    }
    bySession.set(a.conversationId, cur);
  }
  const ranked = [...bySession.values()].sort((x, y) => {
    if (opts.window && x.overlaps !== y.overlaps) return x.overlaps ? -1 : 1;
    if (y.hits !== x.hits) return y.hits - x.hits;
    if (y.scoreSum !== x.scoreSum) return y.scoreSum - x.scoreSum;
    return x.conversationId < y.conversationId ? -1 : 1;
  });
  return ranked.slice(0, Math.max(1, opts.max)).map((r) => r.conversationId);
}

/**
 * Cheap token estimate for the L3 budget check — chars / 4, the usual
 * English-token rule of thumb. Deliberately an over-approximation-safe
 * heuristic (no tokenizer dependency on the escalation hot path): the
 * cap exists to bound cost, and degrading a hair early to widened
 * windows is cheaper than a tokenizer call per escalation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
