import { envFlagEnabled } from '../common/env-validation';

/**
 * Typed Answer Dispatch, lane T1 (docs/roadmap/typed-answer-dispatch-
 * 2026-07.md): a LEXICAL question router — no LLM, no embedding — that
 * recognizes temporal-DISTANCE questions ("how many weeks ago…", "how
 * long since…") and switches the synthesizer into a compute-then-answer
 * frame: every dated fact line gets a precomputed elapsed-time
 * annotation relative to the query's asOf date, so the generator reads
 * the number off instead of doing calendar arithmetic (the measured
 * failure mode: right date retrieved, wrong "N weeks ago" emitted).
 *
 * Lexical-first is deliberate: TF-IDF-class routers match oracle
 * routing on LongMemEval (AgentIR, arXiv 2605.25092), and misroutes
 * fail open — an unrouted temporal question just gets today's generic
 * path. Gated by SYNTHESIZE_ANSWER_ROUTER_ENABLED (default off); the
 * flag lives in the corpus-genre profile, NOT in the LoCoMo config
 * (LoCoMo temporal golds follow the session-date convention, where
 * true date arithmetic measurably hurts — E-series date-context leg).
 */

export type AnswerLane = 'temporal' | 'enumeration';

const UNIT = '(?:day|week|month|year)s?';
/**
 * Temporal-DISTANCE questions require an interval marker (ago / since /
 * passed / between). A bare "how many days did I spend camping" is an
 * enumeration-SUM (add up durations across sessions) and belongs to the
 * enumeration lane — the two lexicons are disjoint by construction.
 */
const TEMPORAL_PATTERNS: RegExp[] = [
  // "how long ago / how long since / how long has it been"
  /how long (?:ago|since|until|has it been|had it been|did it take)/i,
  // "weeks ago", "months have passed", "days elapsed", "years apart"
  new RegExp(`${UNIT} (?:ago|since|apart|passed|have passed|had passed|elapsed)`, 'i'),
  // "days/weeks between X and Y"
  new RegExp(`${UNIT} (?:between|before|after) `, 'i'),
];

/**
 * Enumeration/ordering questions: exhaustive-list discipline (the
 * measured failure mode is PARTIAL enumeration — "4 of 5 model kits").
 */
const ENUMERATION_PATTERNS: RegExp[] = [
  /how many (?!\S+ (?:ago|since))/i, // counting things (temporal wins first)
  /how much (?:total|money|have i spent|did i spend)/i,
  /\b(?:list|name) (?:all|every|the order)/i,
  /what (?:are|were) all\b/i,
  /in (?:what|which) order\b/i,
  /\bwalk me through the order\b/i,
  /\border in which\b/i,
];

export function routerEnabled(): boolean {
  return envFlagEnabled(process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED);
}

export function detectLane(query: string): AnswerLane | null {
  const q = query ?? '';
  for (const p of TEMPORAL_PATTERNS) {
    if (p.test(q)) return 'temporal';
  }
  for (const p of ENUMERATION_PATTERNS) {
    if (p.test(q)) return 'enumeration';
  }
  return null;
}

/**
 * Deterministic elapsed-time annotation for one dated fact vs asOf.
 * All units rendered; the generator picks the one the question asks
 * for. Calendar months (not 30-day approximations): 2022-10-22 →
 * 2023-02-27 is 4 months, not 4.27. Future-dated facts annotate as
 * "in N days". Unparseable/epoch dates render nothing.
 */
export function formatElapsed(
  validFromIso: string | undefined,
  asOfIso: string,
): string {
  if (!validFromIso) return '';
  const from = Date.parse(validFromIso);
  const asOf = Date.parse(asOfIso);
  if (Number.isNaN(from) || Number.isNaN(asOf) || from === 0) return '';
  const dayMs = 86_400_000;
  const days = Math.floor((asOf - from) / dayMs);
  if (days < 0) {
    return ` [elapsed: in ${-days} day${-days === 1 ? '' : 's'}]`;
  }
  const weeks = Math.floor(days / 7);
  const a = new Date(from);
  const b = new Date(asOf);
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  const parts = [`${days} day${days === 1 ? '' : 's'}`];
  if (weeks >= 1) parts.push(`≈ ${weeks} week${weeks === 1 ? '' : 's'}`);
  if (months >= 1) parts.push(`≈ ${months} month${months === 1 ? '' : 's'}`);
  return ` [elapsed: ${parts.join(' ')} before today]`;
}

/** Generator instruction appended for the temporal lane. */
export const TEMPORAL_LANE_INSTRUCTION =
  'This is a temporal-distance question. Dated facts carry precomputed ' +
  '[elapsed: …] annotations relative to Today — answer with the ' +
  'precomputed value in the unit the question asks for; do NOT recompute ' +
  'or estimate the interval yourself.\n';

/**
 * T3 contradiction note. Unlike T1/T2 this lane is EVIDENCE-conditional,
 * not query-conditional: contradiction questions look innocent ("Have I
 * ever …?"), so the trigger is competing facts in the retrieved
 * evidence — the write side already adjudicated them as COMPETING. The
 * measured failure mode (BEAM contradiction_resolution 0%, LIGHT ≤0.042
 * everywhere) is confidently answering ONE side; the expected behavior
 * is to surface both with dates and ask which is correct.
 */
export const CONTRADICTION_NOTE_INSTRUCTION =
  'CONFLICT NOTICE: the facts below include statements the memory ' +
  'system flagged as COMPETING (mutually contradictory), listed as ' +
  'conflict pairs above the fact list. If the question touches a ' +
  'conflict pair, do NOT silently pick a side: state both versions ' +
  'with their dates, note that they contradict each other, and ask ' +
  'which one is correct. This overrides the always-commit rule for ' +
  'those facts only.\n';

/**
 * Generator instruction for the enumeration lane. The measured failure
 * mode is PARTIAL enumeration (a list answer that stops at the first
 * matching items), so the frame forces list-first-then-aggregate.
 */
export const ENUMERATION_LANE_INSTRUCTION =
  'This is an enumeration/counting/ordering question. The facts are ' +
  'sorted chronologically. FIRST enumerate every matching item with its ' +
  'date — scan the whole list, never stop at the first matches; a ' +
  'partial list is a wrong answer. THEN derive the final count, order, ' +
  'or total from your enumeration (sum durations/amounts explicitly ' +
  'when asked for totals).\n';
