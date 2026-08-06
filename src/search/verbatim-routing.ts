import type { VerbatimEvidenceMode } from './retrieval-profile';

/**
 * Verbatim routing — the SEARCH-layer half of the 'routed'
 * verbatimEvidence mode. Lives here (not in the synthesize router)
 * because the fused-leg gate in search.service branches on it and the
 * engine layering is episodes ← derive ← search ← synthesize: the
 * synthesize-side consumers import DOWN into this module, never the
 * reverse.
 */

const UNIT = '(?:day|week|month|year)s?';
/**
 * Temporal-DISTANCE questions require an interval marker (ago / since /
 * passed / between). A bare "how many days did I spend camping" is an
 * enumeration-SUM and belongs to the enumeration lane — the two
 * lexicons are disjoint by construction. (Moved from answer-router.ts
 * with the 'routed' mode; the lane registry imports it from here.)
 */
export const TEMPORAL_PATTERNS: RegExp[] = [
  // "how long ago / how long since / how long has it been"
  /how long (?:ago|since|until|has it been|had it been|did it take)/i,
  // "weeks ago", "months have passed", "days elapsed", "years apart"
  new RegExp(
    `${UNIT} (?:ago|since|apart|passed|have passed|had passed|elapsed)`,
    'i',
  ),
  /how long (?:have|had|has) (?:i|we|you|she|he|they) been/i,
];

/**
 * Verbatim-recall shape: the question asks for ASSISTANT-side content
 * ("what did you suggest…", "what was your answer…"). Extraction is
 * user-fact-shaped and measurably loses assistant content — the LME SSA
 * failure mode is "facts do not specify…" while the verbatim turn sits
 * in L0 (same class as Mem0's 26.8% SSA before their verbatim rewrite,
 * 98.2% after). (Moved from answer-router.ts with the 'routed' mode —
 * the dispatch below keys on it and search may not import up from
 * synthesize; the router re-exports it.)
 */
const VERBATIM_PATTERNS: RegExp[] = [
  /what (?:did|do|have|had) you (?:say|tell|suggest|recommend|propose|advise|share|give|send|write|explain|walk)/i,
  /what (?:was|were) (?:your|the) (?:answer|response|reply|suggestion|recommendation|advice|explanation|instructions?|steps?)/i,
  /\byou (?:told|gave|suggested|recommended|proposed|advised|sent|shared|explained|walked) (?:me|us)\b/i,
  /\b(?:verbatim|word for word|exact wording|exact words|exact phrasing)\b/i,
  /\bquote (?:the|your|what)\b/i,
  /what did (?:the assistant|the bot|it) (?:say|suggest|recommend|advise)/i,
];

export function detectVerbatimShape(query: string): boolean {
  return VERBATIM_PATTERNS.some((p) => p.test(query ?? ''));
}

/**
 * Resolve the profile's verbatimEvidence to the CONCRETE mode for this
 * query. 'routed' dispatches on VERBATIM shape — the only question
 * class where the fused leg measured positive. The V6 three-block
 * evidence (validate-2026-08-results, n=239 pooled): fused-capped vs
 * shape_conditioned is SSA +7.1pp / SSU −10.0pp / TR −8.3pp (pooled
 * −5.0pp) — segments pay exactly when the answer lives in the
 * assistant's verbatim turns, and drown facts everywhere else. So:
 * verbatim-shaped → fused; everything else → shape_conditioned.
 * Misroutes fail open: a missed verbatim ask keeps the shape-
 * conditioned quote lanes (the pre-fused behavior); a false positive
 * just pays the fused leg's tokens on one query.
 *
 * Every other mode resolves to itself. All verbatim consumers — the
 * retrieval-side fused-leg gate and the synthesize-side lane gates —
 * must branch on the value this returns, never on 'routed' itself, so
 * the two sides can never disagree about which regime a request ran.
 */
export function resolveVerbatimMode(
  mode: VerbatimEvidenceMode,
  query: string,
): Exclude<VerbatimEvidenceMode, 'routed'> {
  if (mode !== 'routed') return mode;
  return detectVerbatimShape(query) ? 'fused' : 'shape_conditioned';
}
