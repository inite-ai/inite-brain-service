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
  | 'skip_no_refine';

export interface L3TriggerInput {
  /** profile.l3Escalation. */
  l3Escalation: boolean;
  verdict: VerifierOutput['verdict'];
  /** V10 §5 topic-coverage judgment, when the audit produced it. */
  questionAnswered?: boolean | undefined;
  /** Coverage floor result over the retrieved evidence (below floor →
   *  covered=false, the escalation-eligible state). */
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
}

/**
 * The trigger matrix. Fires only when the fact-grounded answer failed
 * (verifier unsupported/partial, OR the supported-but-not-answering
 * abstain-intent) AND coverage is below floor AND a refine already ran
 * (or the search loop is off) AND nothing escalated yet. Any other
 * combination stays on the normal abstention path.
 */
export function l3TriggerDecision(input: L3TriggerInput): L3TriggerReason {
  if (input.escalated) return 'skip_already_escalated';
  if (!input.l3Escalation) return 'skip_flag_off';
  const verdictFail =
    input.verdict !== 'supported' || input.questionAnswered === false;
  if (!verdictFail) return 'skip_verdict_ok';
  // coverage < floor is required: escalation addresses the residual
  // where the extracted facts are thin, not where a well-covered set
  // merely phrased the answer past the auditor.
  if (input.covered) return 'skip_covered';
  if (input.searchLoop && !input.refineAttempted) return 'skip_no_refine';
  return 'fire';
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
export function verifierPasses(
  verdict: VerifierOutput,
  topicCoverage: boolean,
): boolean {
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
