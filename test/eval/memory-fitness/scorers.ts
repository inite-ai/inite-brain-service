/**
 * Mechanical scorers of the memory-fitness harness. Pure functions over
 * plain JSON — no HTTP, no LLM judge — so they are unit-testable on
 * fixtures (test/memory-fitness-scorers.unit-spec.ts) and every verdict
 * is reproducible from the report file.
 */
import { ABSTAIN_RE } from '../abstain';

const norm = (s: string): string => s.toLowerCase();

/** Case-insensitive: does `text` contain at least one of `needles`? */
export function containsAnyOf(text: string, needles: readonly string[]): boolean {
  const t = norm(text);
  return needles.some((n) => t.includes(norm(n)));
}

/** Case-insensitive: first forbidden needle present in `text`, else null. */
export function findForbidden(text: string, needles: readonly string[]): string | null {
  const t = norm(text);
  for (const n of needles) {
    if (t.includes(norm(n))) return n;
  }
  return null;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * Accepted phrasings of a `yyyy-mm-dd` date. Substring-matched, so
 * "March 18" also covers "March 18th" and "March 18, 2026".
 */
export function dateVariants(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`dateVariants: expected yyyy-mm-dd, got "${iso}"`);
  const [, year, month, day] = m;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`dateVariants: unparseable "${iso}"`);
  }
  const monthName = MONTHS[Number(month) - 1];
  if (monthName === undefined) throw new Error(`dateVariants: bad month in "${iso}"`);
  const shortMonth = monthName.slice(0, 3);
  const bareDay = String(Number(day));
  return [
    iso,
    `${year}/${month}/${day}`,
    `${monthName} ${bareDay}`,
    `${bareDay} ${monthName}`,
    `${shortMonth} ${bareDay}`,
    `${bareDay} ${shortMonth}`,
  ];
}

/** Does the answer name the expected `yyyy-mm-dd` date in any phrasing? */
export function matchesDate(text: string, iso: string): boolean {
  return containsAnyOf(text, dateVariants(iso));
}

/**
 * Abstention detector: a null/empty answer, or the shared decline
 * regex (test/eval/abstain.ts — covers the brain's own guardrail
 * sentinel), or an explicit abstain reason.
 */
export function isAbstention(answer: string | null | undefined, reason?: string): boolean {
  if (answer === null || answer === undefined) return true;
  if (answer.trim().length === 0) return true;
  if (ABSTAIN_RE.test(answer)) return true;
  return reason !== undefined && /abstain|no_facts|unsupported|partial/i.test(reason);
}

/** Minimal provenance shape the walker needs (mirrors FactProvenanceResult). */
export interface ProvenanceLike {
  factId?: string;
  episodes?: Array<{ episodeId?: string; text?: string }>;
}

export interface ProvenanceMatch {
  episodeId: string;
  fragment: string;
}

/**
 * Provenance walker: does any grounding episode's verbatim text contain
 * one of the seeded corpus fragments? Returns the first match, so a
 * pass names the exact episode + fragment in the report.
 */
export function walkProvenance(
  prov: ProvenanceLike,
  fragments: readonly string[],
): ProvenanceMatch | null {
  const episodes = prov.episodes ?? [];
  for (const ep of episodes) {
    const text = ep.text;
    if (typeof text !== 'string') continue;
    for (const fragment of fragments) {
      if (norm(text).includes(norm(fragment))) {
        return { episodeId: ep.episodeId ?? '(unknown episode)', fragment };
      }
    }
  }
  return null;
}

/** One timeline event as the evolution checker consumes it. */
export interface EvolutionEvent {
  predicate: string;
  object: string;
  /** ISO timestamp the event was recorded/valid at. */
  at: string;
}

export interface EvolutionVerdict {
  pass: boolean;
  detail: string;
}

/**
 * Evolution checker: within one predicate's history, the old value and
 * the new value are BOTH retained, and the old one precedes the new
 * one. A memory that garbage-collects superseded state fails here even
 * when D1 passes.
 */
export function checkEvolution(
  events: readonly EvolutionEvent[],
  predicate: string,
  oldMarkers: readonly string[],
  newMarkers: readonly string[],
): EvolutionVerdict {
  const relevant = events.filter((e) => e.predicate === predicate);
  const firstOld = relevant.find((e) => containsAnyOf(e.object, oldMarkers));
  const firstNew = relevant.find((e) => containsAnyOf(e.object, newMarkers));
  if (!firstOld && !firstNew) {
    return { pass: false, detail: `no ${predicate} events matched either value` };
  }
  if (!firstOld) return { pass: false, detail: 'old value missing from history' };
  if (!firstNew) return { pass: false, detail: 'new value missing from history' };
  if (Date.parse(firstOld.at) > Date.parse(firstNew.at)) {
    return { pass: false, detail: 'history orders the new value before the old one' };
  }
  return {
    pass: true,
    detail: `history retains "${firstOld.object}" -> "${firstNew.object}" in order`,
  };
}

/**
 * Key-phrase scorer (D8): every group must be satisfied; a plain string
 * is a required substring, an array is an any-of group. Returns the
 * missing groups (empty = pass).
 */
export function missingKeyPhrases(
  text: string,
  groups: ReadonlyArray<string | string[]>,
): string[] {
  const missing: string[] = [];
  for (const group of groups) {
    const alternatives = Array.isArray(group) ? group : [group];
    if (!containsAnyOf(text, alternatives)) {
      missing.push(alternatives.join(' | '));
    }
  }
  return missing;
}

export type ConflictAnswerVerdict = 'both-sides' | 'abstained' | 'one-sided' | 'neither';

/**
 * Conflict-answer classifier (D6): with two live contradictory sources
 * the honest behaviours are naming both sides or abstaining; silently
 * serving exactly one side is the failure being measured.
 */
export function classifyConflictAnswer(
  answer: string | null | undefined,
  sideA: readonly string[],
  sideB: readonly string[],
  reason?: string,
): ConflictAnswerVerdict {
  if (isAbstention(answer, reason)) return 'abstained';
  const text = answer ?? '';
  const hasA = containsAnyOf(text, sideA);
  const hasB = containsAnyOf(text, sideB);
  if (hasA && hasB) return 'both-sides';
  if (hasA || hasB) return 'one-sided';
  return 'neither';
}
