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

export type AnswerLane = 'temporal';

const UNIT = '(?:day|week|month|year)s?';
const TEMPORAL_PATTERNS: RegExp[] = [
  // "how many days/weeks/months (ago|since|between|passed|have passed)"
  new RegExp(`how (?:many|much) ${UNIT}`, 'i'),
  // "how long ago / how long since / how long has it been"
  /how long (?:ago|since|until|has it been|had it been|did it take)/i,
  // "N days ago did/was ..." asked forms: "how many weeks ago did I ..."
  new RegExp(`${UNIT} (?:ago|since|apart|passed|have passed|had passed|elapsed)`, 'i'),
  // "days/weeks between X and Y"
  new RegExp(`${UNIT} (?:between|before|after) `, 'i'),
];

export function routerEnabled(): boolean {
  return envFlagEnabled(process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED);
}

export function detectLane(query: string): AnswerLane | null {
  const q = query ?? '';
  for (const p of TEMPORAL_PATTERNS) {
    if (p.test(q)) return 'temporal';
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
