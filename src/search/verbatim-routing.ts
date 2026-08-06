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
 * Timeline shape — the verbatim router's dispatch lexicon. Broader
 * than TEMPORAL_PATTERNS by design: the temporal LANE only frames
 * distance questions ("how long ago"), while the fused-vs-
 * shape_conditioned split measured in the V6 legs (TR −7.1pp at 2.7×
 * tokens vs SSA +7.1pp) tracks the whole timeline family — "when
 * did…", "what date…", first/last-time, before/after ordering.
 * Misroutes fail open in BOTH directions: a timeline query that slips
 * through just runs the (more expensive) fused leg; a session query
 * caught here just loses segments-as-hits and keeps the
 * shape-conditioned quote lanes.
 */
const TIMELINE_PATTERNS: RegExp[] = [
  ...TEMPORAL_PATTERNS,
  /\bwhen (?:did|was|were|do|does|is|had|have)\b/i,
  /\bwhat (?:date|day|month|year|time)\b/i,
  /\bon (?:what|which) (?:date|day)\b/i,
  /\b(?:first|last) time\b/i,
  /\bbefore or after\b/i,
  /\bhow (?:recently|long)\b/i,
];

/**
 * Resolve the profile's verbatimEvidence to the CONCRETE mode for this
 * query. 'routed' dispatches on timeline shape; every other mode
 * resolves to itself. All verbatim consumers — the retrieval-side
 * fused-leg gate and the synthesize-side lane gates — must branch on
 * the value this returns, never on 'routed' itself, so the two sides
 * can never disagree about which regime a request ran.
 */
export function resolveVerbatimMode(
  mode: VerbatimEvidenceMode,
  query: string,
): Exclude<VerbatimEvidenceMode, 'routed'> {
  if (mode !== 'routed') return mode;
  const timeline = TIMELINE_PATTERNS.some((p) => p.test(query ?? ''));
  return timeline ? 'shape_conditioned' : 'fused';
}
