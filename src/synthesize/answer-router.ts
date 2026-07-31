import { envFlagEnabled } from '../common/env-validation';
import {
  parseDisabledLanes,
  type DispatchLane,
} from './lanes-disabled';
import type { SearchHit } from '../search/search.service';

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

export type AnswerLane = 'temporal' | 'enumeration' | 'preference' | 'summary';

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

export function routerEnabled(): boolean {
  return envFlagEnabled(process.env.SYNTHESIZE_ANSWER_ROUTER_ENABLED);
}

/**
 * Per-lane ablation set (SYNTHESIZE_LANES_DISABLED=t3,t5 …): a disabled
 * lane behaves as if it was never built — its patterns are skipped
 * during detection, so the query falls through to later lexicons or the
 * legacy path. Unknown tokens are rejected at boot (env-validation).
 */
export function disabledLanes(): ReadonlySet<DispatchLane> {
  return parseDisabledLanes(process.env.SYNTHESIZE_LANES_DISABLED).lanes;
}

/** Router on AND the specific lane not ablated. */
export function laneEnabled(lane: DispatchLane): boolean {
  return routerEnabled() && !disabledLanes().has(lane);
}

/** Flag-gated entry: null (legacy path) unless the router is enabled. */
export function routeLane(query: string): AnswerLane | null {
  return routerEnabled() ? detectLane(query, disabledLanes()) : null;
}

export function detectLane(
  query: string,
  skip?: ReadonlySet<DispatchLane>,
): AnswerLane | null {
  const q = query ?? '';
  const off = (lane: AnswerLane) => skip?.has(lane) === true;
  if (!off('temporal')) {
    for (const p of TEMPORAL_PATTERNS) {
      if (p.test(q)) return 'temporal';
    }
  }
  if (!off('enumeration')) {
    for (const p of ENUMERATION_PATTERNS) {
      if (p.test(q)) return 'enumeration';
    }
  }
  if (!off('preference')) {
    for (const p of PREFERENCE_PATTERNS) {
      if (p.test(q)) return 'preference';
    }
  }
  if (!off('summary')) {
    for (const p of SUMMARY_PATTERNS) {
      if (p.test(q)) return 'summary';
    }
  }
  return null;
}

/**
 * T2b first-mention ordering: the subset of enumeration questions that
 * ask for the ORDER topics were brought up (BEAM event_ordering: golds
 * are ordered lists of topic introductions, scored by Kendall tau over
 * an LLM-aligned list; the response is split on newlines). Gated by
 * SYNTHESIZE_ORDERING_FIRST_MENTION on top of the enumeration lane.
 */
const ORDERING_PATTERNS: RegExp[] = [
  /in (?:what|which) order\b/i,
  /\border in which\b/i,
  /\bwalk me through the order\b/i,
  /\b(?:list|name) the order\b/i,
];

export function detectOrderingShape(query: string): boolean {
  const q = query ?? '';
  return ORDERING_PATTERNS.some((p) => p.test(q));
}

export function orderingFirstMentionEnabled(): boolean {
  return (
    laneEnabled('enumeration') &&
    envFlagEnabled(process.env.SYNTHESIZE_ORDERING_FIRST_MENTION)
  );
}

/**
 * T6/T2 wide probe (SYNTHESIZE_LANE_WIDE_PROBE): the measured lesson of
 * the null summary/enumeration legs is that a render frame cannot fix
 * recall breadth — the top-K similarity slice can't cover a
 * whole-project narrative. For summary/enumeration-routed questions a
 * second retrieval runs with a pseudo-relevance-feedback query
 * (original query + dominant aspect predicates + top entity names from
 * the base hits — deterministic, no LLM), pulling same-topic facts the
 * literal question wording never surfaces. Extra facts enter through
 * the evidence union under SYNTHESIZE_EXTRA_EVIDENCE_CAP.
 */
export function wideLaneProbeEnabled(): boolean {
  return (
    routerEnabled() &&
    envFlagEnabled(process.env.SYNTHESIZE_LANE_WIDE_PROBE)
  );
}

export function wideProbeLimit(): number {
  const v = parseInt(process.env.SYNTHESIZE_WIDE_PROBE_LIMIT ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 12;
}

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
 * T4: deterministic second retrieval probe that pulls the user's stored
 * preferences into evidence — recommendation queries rarely surface
 * them by similarity (the query is about hotels, not about tastes).
 */
export const PREFERENCE_PROBE_QUERY =
  'preferences likes dislikes favorite style enjoys prefers avoids';

/**
 * T7 instruction lane (SYNTHESIZE_INSTRUCTION_LANE): standing user
 * instructions ("always format code with syntax highlighting when I ask
 * about implementation") are captured by the substrate as preference
 * facts (probed live 2026-07-31: the fact exists and even surfaces on a
 * neutral question — at position 33/40, with nothing telling the
 * generator to APPLY it to the answer's form). BEAM's IF questions are
 * deliberately neutral, so no lexical route can fire — the lane is
 * UNCONDITIONAL, like T3: a fixed probe pulls instruction-shaped facts
 * and they render as a separate standing-instructions section. LIGHT's
 * relevance-gated scratchpad filters exactly these out (its IF never
 * exceeds 0.5); unconditional injection is the structural fix.
 */
export function instructionLaneEnabled(): boolean {
  return (
    laneEnabled('instruction') &&
    envFlagEnabled(process.env.SYNTHESIZE_INSTRUCTION_LANE)
  );
}

export const INSTRUCTION_PROBE_QUERY =
  'always include format style make sure when I ask prefers ' +
  'instructions how to answer respond';

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

/** T7 section header: compliance is part of correctness. */
export const STANDING_INSTRUCTIONS_INSTRUCTION =
  'Standing user instructions found in memory (they govern HOW you ' +
  'answer — format, style, required elements): APPLY every instruction ' +
  'whose trigger matches this question; an answer that ignores an ' +
  'applicable instruction is a wrong answer. Ignore the ones whose ' +
  'trigger does not match.\n';

/**
 * Second-retrieval request per lane, or null when the lane probes
 * nothing: T4's fixed tastes probe; the flag-gated T6/T2 PRF widening.
 * Pure — the service just executes whatever this returns.
 */
export function laneProbeDto(
  lane: AnswerLane | null,
  query: string,
  baseHits: SearchHit[],
): { query: string; limit: number } | null {
  if (lane === 'preference') {
    return { query: PREFERENCE_PROBE_QUERY, limit: 8 };
  }
  if (
    (lane === 'summary' || lane === 'enumeration') &&
    wideLaneProbeEnabled()
  ) {
    return {
      query: buildWideProbeQuery(query, baseHits),
      limit: wideProbeLimit(),
    };
  }
  return null;
}

/**
 * Calendar difference between two instants: whole days, whole weeks,
 * whole calendar months (2022-10-22 → 2023-02-27 is 4 months, not
 * 4.27). Shared by the T1 elapsed annotation and the T1b pair table.
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

export function temporalIntervalsEnabled(): boolean {
  return (
    laneEnabled('temporal') &&
    envFlagEnabled(process.env.SYNTHESIZE_TEMPORAL_EVENT_INTERVALS)
  );
}

/** Distinct evidence dates entering the pair table (first-seen wins). */
const INTERVAL_TABLE_MAX_DATES = 10;

/**
 * T1b event-interval table (SYNTHESIZE_TEMPORAL_EVENT_INTERVALS): the
 * pairwise calendar difference between every two distinct dates in the
 * evidence, computed in code. Event-anchored benchmarks (BEAM) ask the
 * time BETWEEN two events and their golds carry no notion of "today" —
 * distance-to-today annotations are decoys there; the expected answer
 * shape is "N units, from DATE1 till DATE2", which reads straight off
 * a pair row. Dates cap at first-seen (evidence ≈ relevance) order.
 */
export function buildIntervalTable(results: SearchHit[]): string[] {
  const days: string[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const f of r.facts) {
      const iso = (f as { validFrom?: string }).validFrom;
      if (!iso) continue;
      const t = Date.parse(iso);
      if (Number.isNaN(t) || t === 0) continue;
      const day = new Date(t).toISOString().slice(0, 10);
      if (seen.has(day)) continue;
      seen.add(day);
      if (days.length < INTERVAL_TABLE_MAX_DATES) days.push(day);
    }
  }
  days.sort();
  const lines: string[] = [];
  for (let i = 0; i < days.length; i += 1) {
    for (let j = i + 1; j < days.length; j += 1) {
      const from = Date.parse(`${days[i]}T00:00:00.000Z`);
      const to = Date.parse(`${days[j]}T00:00:00.000Z`);
      lines.push(
        `${days[i]} → ${days[j]}: ${renderDiffParts(calendarDiff(from, to))}`,
      );
    }
  }
  return lines;
}

/** T1b frame: intervals are read off the table, never recomputed. */
export const TEMPORAL_INTERVAL_INSTRUCTION =
  'This is a temporal-interval question about the time between two ' +
  'events. The date-interval table below lists the precomputed ' +
  'calendar difference between every pair of dates present in the ' +
  'facts. Identify the two events the question refers to, find their ' +
  'dates in the facts, and READ the interval off the table — do NOT ' +
  'compute calendar arithmetic yourself. Answer with the interval in ' +
  'the unit the question asks for and name both dates (from DATE1 ' +
  'till DATE2).\n';

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

/** T4 answer conditioning (PrefEval "reminder" pattern). */
export const PREFERENCE_LANE_INSTRUCTION =
  'This is a recommendation question. FIRST scan the facts for the ' +
  "user's stated preferences, tastes, constraints or dislikes relevant " +
  'to the request; then condition your suggestion on them explicitly, ' +
  'naming which stored preference you applied. A generic recommendation ' +
  'that ignores a stated preference is a wrong answer.\n';

/**
 * T2b frame: the facts are sorted and annotated by FIRST MENTION (when
 * the topic was brought up in conversation), which is the asked-for
 * order — event dates inside the propositions are decoys whenever
 * events were narrated out of order. The bare newline-separated list
 * shape matches how ordering answers are consumed (BEAM splits the
 * response on newlines; extra prose becomes spurious list items).
 */
export const ORDERING_LANE_INSTRUCTION =
  'This is a mention-order question: it asks the order in which topics ' +
  'were BROUGHT UP in conversation, not the order events happened. The ' +
  'facts are sorted by their [first mentioned: …] annotations — derive ' +
  'the order from those annotations only; ignore event dates inside the ' +
  'fact text. Answer with ONLY a newline-separated list of short topic ' +
  'labels in first-mention order, nothing else — no preamble, no ' +
  'commentary. If the question asks for exactly N items, give exactly ' +
  'N: cluster related facts into broader topics until N remain.\n';

/** T6 staged-narrative frame over chronologically sorted facts. */
export const SUMMARY_LANE_INSTRUCTION =
  'This is a progressive-summary question. The facts are sorted ' +
  'chronologically. Produce a staged narrative: initial state, the key ' +
  'developments with their dates, and the current state. Scan ALL the ' +
  'facts — a summary built from one time slice is a wrong answer.\n';

/**
 * T3: detect write-side-adjudicated conflicts inside the retrieved
 * evidence. Conservative by design: a slot counts as conflicted ONLY
 * when its facts disagree on the object AND at least one carries the
 * COMPETING status the conflict predictor assigned at write time —
 * ordinary multi-value slots (works_at, likes, …) never trigger. Pure,
 * exported for tests.
 */
export function detectEvidenceConflicts(
  results: SearchHit[],
): Array<{ factIds: string[]; label: string }> {
  if (!laneEnabled('contradiction')) return [];
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
