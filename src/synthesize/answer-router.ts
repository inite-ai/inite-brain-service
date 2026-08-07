import type { SearchHit } from '../search/search.service';
import type { LaneId, RetrievalProfile } from '../search/retrieval-profile';

/**
 * Typed Answer Dispatch (docs/roadmap/typed-answer-dispatch-2026-07.md):
 * a LEXICAL question router — no LLM, no embedding — over a first-class
 * Lane registry. Each lane owns its detection lexicon, its optional
 * deterministic second-retrieval probe, and its generator frame; the
 * router, the probe runner and the prompt builder all iterate the SAME
 * registry, so adding a lane is one entry in one file.
 *
 * Which lanes are live is per-tenant configuration: the resolved
 * platform directive); this module is env-free.
 *
 * Lexical-first is deliberate: TF-IDF-class routers match oracle
 * routing on LongMemEval (AgentIR, arXiv 2605.25092), and misroutes
 * fail open — an unrouted question just gets the generic path.
 */

/**
 * One lane type system (audit W5 #27 carried): the canonical LaneId
 * union lives in the profile; the router's output is a LaneId whose
 * registry entry carries `detect` — narrowed at runtime by routing,
 * not by a parallel type union. Re-exported so synthesize-side
 * consumers name the type without reaching into the search layer.
 */
export type { LaneId } from '../search/retrieval-profile';

/**
 * Temporal-distance lexicon: moved to the search layer with the
 * 'routed' verbatim mode (verbatim-routing.ts) — the timeline dispatch
 * lexicon builds on it and the fused-leg gate in search.service may
 * not import UP from synthesize (engine layering gate). First-person
 * perfect ("how long have/had I been…") entered the lexicon after the
 * LME-500 router-ON leg, where 55 of 109 judged temporal questions
 * missed every pattern (25.5% accuracy unrouted).
 */
import { TEMPORAL_PATTERNS } from '../search/verbatim-routing';

/**
 * Verbatim-recall shape: the question asks for ASSISTANT-side content
 * ("what did you suggest…", "what was your answer…"). The lexicon and
 * detector moved to the search layer (verbatim-routing.ts) with the
 * 'routed' verbatim mode — its dispatch keys on this shape and search
 * may not import up from synthesize. The fix stays evidence-side, not
 * framing-side: this shape pulls role-tagged episode quotes into the
 * prompt (see SynthesizeService.collectTranscriptLines), so it is
 * deliberately NOT a routed lane — it composes with whatever lane
 * frames the answer. Re-exported here for the synthesize-side callers.
 */
export { detectVerbatimShape } from '../search/verbatim-routing';

/**
 * Enumeration/ordering questions: exhaustive-list discipline (the
 * measured failure mode is PARTIAL enumeration — "4 of 5 model kits").
 * "What is/was the order of…" joined after the LME-500 gap analysis.
 */
/**
 * The order-lexicon: mention-order / sequence questions (the BEAM
 * event_ordering shape — "list the order in which I brought up…" — plus
 * pairwise comparatives). Kept separate from the counting patterns so
 * the V8 timeline-evidence gate can key on ORDERING specifically:
 * mention order lives in the episodic record (occurredAt), not in fact
 * validFrom stamps — event-time extraction collapses a session's
 * mentions onto one date, so order within it is unrecoverable from
 * facts alone (the measured event_ordering failure: chronological fact
 * enumeration with every item stamped the same day). Matches 40/40 of
 * the BEAM event_ordering row, 0 of SSA/SSU/MS and LoCoMo dev-5.
 */
const ORDERING_PATTERNS: RegExp[] = [
  /\b(?:list|name) the order\b/i,
  /in (?:what|which) order\b/i,
  /\bwalk me through the order\b/i,
  /\border in which\b/i,
  /what (?:is|was) the order of\b/i,
  /\blist in order\b/i,
  /\bbefore or after\b/i,
  /\bwhich (?:came|happened|occurred) (?:first|last|earlier|later)\b/i,
];

/** Ordering/sequence shape — the timeline-evidence dispatch key. */
export function detectOrderingShape(query: string): boolean {
  return ORDERING_PATTERNS.some((p) => p.test(query ?? ''));
}

const ENUMERATION_PATTERNS: RegExp[] = [
  /how many (?!\S+ (?:ago|since))/i, // counting things (temporal wins first)
  /how much (?:total|money|have i spent|did i spend)/i,
  /\b(?:list|name) (?:all|every)\b/i,
  /what (?:are|were) all\b/i,
  ...ORDERING_PATTERNS,
];

/**
 * T4 preference/recommendation questions: the failure mode is a generic
 * suggestion that ignores stored preferences (PrefEval: verbatim
 * preference injection beats CoT — the fix is retrieval + conditioning,
 * not more reasoning).
 */
const PREFERENCE_PATTERNS: RegExp[] = [
  /can you (?:recommend|suggest)\b/i,
  /\b(?:recommend|suggest) (?:some|a|an|me)\b/i,
  /what (?:should|would) i (?:read|watch|try|do|buy|visit|listen)/i,
  /any (?:recommendations|suggestions)\b/i,
];

/** T6 progressive-summary questions: staged narrative over a topic. */
const SUMMARY_PATTERNS: RegExp[] = [
  /\b(?:comprehensive |detailed )?summar(?:y|ize|ise)\b/i,
  /how (?:has|have|did) .{0,60}(?:progress|develop|evolv|unfold)/i,
  /give me an overview of\b/i,
];

/** Generator instruction appended for the temporal lane. */
export const TEMPORAL_LANE_INSTRUCTION =
  'This is a temporal-distance question. Dated facts carry precomputed ' +
  '[elapsed: …] annotations relative to Today — answer with the ' +
  'precomputed value in the unit the question asks for; do NOT recompute ' +
  'or estimate the interval yourself.\n';

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

/** T4 answer conditioning (PrefEval "reminder" pattern). */
const PREFERENCE_LANE_INSTRUCTION =
  'This is a recommendation question. FIRST scan the facts for the ' +
  "user's stated preferences, tastes, constraints or dislikes relevant " +
  'to the request; then condition your suggestion on them explicitly, ' +
  'naming which stored preference you applied. A generic recommendation ' +
  'that ignores a stated preference is a wrong answer.\n';

/** T6 staged-narrative frame over chronologically sorted facts. */
const SUMMARY_LANE_INSTRUCTION =
  'This is a progressive-summary question. The facts are sorted ' +
  'chronologically. Produce a staged narrative: initial state, the key ' +
  'developments with their dates, and the current state. Scan ALL the ' +
  'facts — a summary built from one time slice is a wrong answer.\n';

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

/** T7 section header: compliance is part of correctness. */
export const STANDING_INSTRUCTIONS_INSTRUCTION =
  'Standing user instructions found in memory (they govern HOW you ' +
  'answer — format, style, required elements): APPLY every instruction ' +
  'whose trigger matches this question; an answer that ignores an ' +
  'applicable instruction is a wrong answer. Ignore the ones whose ' +
  'trigger does not match.\n';

/**
 * T4: deterministic second retrieval probe that pulls the user's stored
 * preferences into evidence — recommendation queries rarely surface
 * them by similarity (the query is about hotels, not about tastes).
 */
const PREFERENCE_PROBE_QUERY =
  'preferences likes dislikes favorite style enjoys prefers avoids';

/**
 * T7 instruction lane: standing user instructions ("always format code
 * with syntax highlighting when I ask about implementation") are
 * captured by the substrate as preference facts. BEAM's IF questions
 * are deliberately neutral, so no lexical route can fire — the lane is
 * UNCONDITIONAL, like T3: a fixed probe pulls instruction-shaped facts
 * and they render as a separate standing-instructions section. LIGHT's
 * relevance-gated scratchpad filters exactly these out (its IF never
 * exceeds 0.5); unconditional injection is the structural fix.
 */
export const INSTRUCTION_PROBE_QUERY =
  'always include format style make sure when I ask prefers ' +
  'instructions how to answer respond';

/** PRF query: base query + ≤2 top entity names + ≤4 dominant aspects. */
export function buildWideProbeQuery(
  query: string,
  hits: SearchHit[],
): string {
  const names = hits.slice(0, 2).map((h) => h.canonicalName);
  const counts = new Map<string, number>();
  for (const h of hits) {
    for (const f of h.facts) {
      counts.set(f.predicate, (counts.get(f.predicate) ?? 0) + 1);
    }
  }
  const aspects = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p]) => p);
  return [query, ...names, ...aspects].join(' ');
}

/**
 * One lane of the typed dispatcher, first-class (audit #27: adding a
 * lane used to be 14 edits across 5 files with two parallel lane type
 * systems). `detect` is absent for evidence-conditional lanes
 * (contradiction fires on COMPETING evidence, recency on slot shape,
 * instruction unconditionally); `probe` is the lane's deterministic
 * second retrieval; `instruction` is the generator frame the prompt
 * builder renders when the lane routed the answer.
 */
export interface Lane {
  id: LaneId;
  detect?: (query: string) => boolean;
  probe?: (
    query: string,
    baseHits: SearchHit[],
    profile: RetrievalProfile,
  ) => { query: string; limit: number } | null;
  instruction?: string;
}

const matchesAny = (patterns: RegExp[]) => (q: string) =>
  patterns.some((p) => p.test(q ?? ''));

/**
 * THE lane registry. Registry order IS detection precedence: temporal
 * wins over enumeration, etc. Every LaneId has exactly one entry (gate:
 * lane-registry completeness).
 */
export const LANE_REGISTRY: readonly Lane[] = [
  {
    id: 'temporal',
    detect: matchesAny(TEMPORAL_PATTERNS),
    instruction: TEMPORAL_LANE_INSTRUCTION,
  },
  {
    id: 'enumeration',
    detect: matchesAny(ENUMERATION_PATTERNS),
    instruction: ENUMERATION_LANE_INSTRUCTION,
    // T6/T2 wide probe: the measured lesson of the null summary/
    // enumeration legs is that a render frame cannot fix recall breadth.
    // A PRF second retrieval (query + dominant aspects + top entity
    // names — deterministic, no LLM) pulls same-topic facts the literal
    // wording never surfaces; extras enter through the evidence union
    // under the profile's extraEvidenceCap.
    probe: (query, baseHits, profile) =>
      profile.wideProbe
        ? {
            query: buildWideProbeQuery(query, baseHits),
            limit: profile.wideProbeLimit,
          }
        : null,
  },
  {
    id: 'preference',
    detect: matchesAny(PREFERENCE_PATTERNS),
    instruction: PREFERENCE_LANE_INSTRUCTION,
    probe: () => ({ query: PREFERENCE_PROBE_QUERY, limit: 8 }),
  },
  {
    id: 'summary',
    detect: matchesAny(SUMMARY_PATTERNS),
    instruction: SUMMARY_LANE_INSTRUCTION,
    probe: (query, baseHits, profile) =>
      profile.wideProbe
        ? {
            query: buildWideProbeQuery(query, baseHits),
            limit: profile.wideProbeLimit,
          }
        : null,
  },
  // Evidence-conditional lanes — no query detection by design.
  { id: 'contradiction', instruction: CONTRADICTION_NOTE_INSTRUCTION },
  { id: 'recency' },
  { id: 'instruction', instruction: STANDING_INSTRUCTIONS_INSTRUCTION },
];

const LANE_BY_ID = new Map(LANE_REGISTRY.map((l) => [l.id, l]));

/** Registry lookup for the prompt builder; undefined for unrouted. */
export function laneInstructionFor(lane: LaneId | null | undefined):
  | string
  | undefined {
  return lane ? LANE_BY_ID.get(lane)?.instruction : undefined;
}

/**
 * Route the query over the registry's detectable lanes, restricted to
 * the profile's active set. Registry order is precedence; null = no
 * typed dispatch (generic path).
 */
export function routeLane(
  profile: RetrievalProfile,
  query: string,
): LaneId | null {
  for (const lane of LANE_REGISTRY) {
    if (!lane.detect || !profile.lanes.has(lane.id)) continue;
    if (lane.detect(query ?? '')) return lane.id;
  }
  return null;
}

/** Detection over every registry lexicon, ignoring the profile — for
 *  tests and offline tooling that ask "what WOULD this route to". */
export function detectLane(query: string): LaneId | null {
  for (const lane of LANE_REGISTRY) {
    if (lane.detect?.(query ?? '')) return lane.id;
  }
  return null;
}

/**
 * Second-retrieval request for the routed lane, or null when the lane
 * probes nothing under this profile. Pure — the service just executes
 * whatever this returns.
 */
export function laneProbeDto(
  profile: RetrievalProfile,
  lane: LaneId | null,
  probe: { query: string; baseHits: SearchHit[] },
): { query: string; limit: number } | null {
  if (!lane || !profile.lanes.has(lane)) return null;
  return (
    LANE_BY_ID.get(lane)?.probe?.(probe.query, probe.baseHits, profile) ?? null
  );
}

/**
 * Instruction-shaped fact filter. Two tiers against false positives
 * ("has never written any Flask routes" is a work fact, not an
 * instruction): preference-aspect facts match on any trigger word;
 * other aspects need a STRONG imperative trigger (bare "never"/"when
 * asking" is not enough).
 */
const INSTRUCTION_TRIGGER_RE =
  /\b(?:always|never|whenever|when(?:ever)? (?:i|they|the user) asks?|when asking|make sure)\b/i;
const INSTRUCTION_STRONG_RE =
  /\b(?:always|make sure|when(?:ever)? (?:i|they|the user) asks?)\b/i;

/** Dedup + cap standing instructions found across evidence and probe. */
export function extractStandingInstructions(
  hits: SearchHit[],
  cap = 8,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    for (const f of h.facts) {
      const re =
        f.predicate === 'preferences'
          ? INSTRUCTION_TRIGGER_RE
          : INSTRUCTION_STRONG_RE;
      if (!re.test(f.object)) continue;
      const key = f.object.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length < cap) out.push(f.object.trim());
    }
  }
  return out;
}

/**
 * Calendar difference between two instants: whole days, whole weeks,
 * whole calendar months (2022-10-22 → 2023-02-27 is 4 months, not
 * 4.27). The core of the T1 elapsed annotation.
 */
function calendarDiff(fromMs: number, toMs: number): {
  days: number;
  weeks: number;
  months: number;
} {
  const days = Math.floor((toMs - fromMs) / 86_400_000);
  const a = new Date(fromMs);
  const b = new Date(toMs);
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return { days, weeks: Math.floor(days / 7), months };
}

/** "128 days ≈ 18 weeks ≈ 4 months" — sub-unit parts only when whole. */
function renderDiffParts(d: ReturnType<typeof calendarDiff>): string {
  const parts = [`${d.days} day${d.days === 1 ? '' : 's'}`];
  if (d.weeks >= 1) parts.push(`≈ ${d.weeks} week${d.weeks === 1 ? '' : 's'}`);
  if (d.months >= 1) {
    parts.push(`≈ ${d.months} month${d.months === 1 ? '' : 's'}`);
  }
  return parts.join(' ');
}

/**
 * Deterministic elapsed-time annotation for one dated fact vs asOf.
 * All units rendered; the generator picks the one the question asks
 * for. Future-dated facts annotate as "in N days". Unparseable/epoch
 * dates render nothing.
 */
export function formatElapsed(
  validFromIso: string | undefined,
  asOfIso: string,
): string {
  if (!validFromIso) return '';
  const from = Date.parse(validFromIso);
  const asOf = Date.parse(asOfIso);
  if (Number.isNaN(from) || Number.isNaN(asOf) || from === 0) return '';
  const diff = calendarDiff(from, asOf);
  if (diff.days < 0) {
    return ` [elapsed: in ${-diff.days} day${-diff.days === 1 ? '' : 's'}]`;
  }
  return ` [elapsed: ${renderDiffParts(diff)} before today]`;
}

/**
 * T3: detect write-side-adjudicated conflicts inside the retrieved
 * evidence. Conservative by design: a slot counts as conflicted ONLY
 * when its facts disagree on the object AND at least one carries the
 * COMPETING status the conflict predictor assigned at write time —
 * ordinary multi-value slots (works_at, likes, …) never trigger. Pure,
 * exported for tests. `lanes` is the profile's active set — the
 * contradiction lane must be live for the notice to render.
 */
export function detectEvidenceConflicts(
  results: SearchHit[],
  lanes: ReadonlySet<LaneId>,
): Array<{ factIds: string[]; label: string }> {
  if (!lanes.has('contradiction')) return [];
  const bySlot = new Map<
    string,
    Array<{ factId: string; object: string; status?: string }>
  >();
  for (const r of results) {
    for (const f of r.facts) {
      const key = `${r.entityId}::${f.predicate}`;
      const arr = bySlot.get(key) ?? [];
      arr.push({
        factId: f.factId,
        object: f.object,
        status: (f as { status?: string }).status,
      });
      bySlot.set(key, arr);
    }
  }
  const conflicts: Array<{ factIds: string[]; label: string }> = [];
  for (const [slot, facts] of bySlot) {
    const objects = new Set(facts.map((f) => f.object));
    if (objects.size < 2) continue;
    const hasCompeting = facts.some(
      (f) => (f.status ?? '').toUpperCase() === 'COMPETING',
    );
    // Second tier for DERIVED worlds: the window deriver batch-INSERTs
    // propositions past the conflict predictor, so contradictions sit as
    // plain 'active' rows. Seeded contradictions are never/always-shaped
    // — flag a slot whose statements disagree on polarity (one side
    // negated, the other not). Never fires on ordinary multi-value
    // slots: two affirmative objects share polarity.
    const negated = facts.filter((f) => NEGATION_RE.test(f.object));
    const polaritySplit =
      negated.length > 0 && negated.length < facts.length;
    if (hasCompeting || polaritySplit) {
      conflicts.push({
        factIds: facts.map((f) => f.factId),
        label: slot.split('::')[1] ?? slot,
      });
    }
  }
  return conflicts;
}

/** Negation markers for the polarity tier of the conflict detector. */
const NEGATION_RE =
  /\b(?:never|has(?:n't| not)|have(?:n't| not)|did(?:n't| not)|does not|doesn't)\b/i;
