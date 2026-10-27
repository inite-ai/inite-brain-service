/**
 * The relationship context an agent reads before it speaks to a person
 * (docs/roadmap/relationship-layer-2026-10.md §2.5): how to treat them,
 * what is owed to them, what they want to come back to, how they are —
 * and how sure the memory is of that.
 *
 * Built from the person's OWN memory only (`userId` = the person): their
 * boundaries are the core `instruction` predicate, the rest is the
 * `relationship` pack's vocabulary. Tenant-global rules are not a
 * relationship and stay out. Every item carries its factId, so an agent
 * can cite it, and the reader can ask brain why it is remembered.
 *
 * Pure: rows in, context out — the read lives in EntitiesService.
 */

/** The `relationship` pack's namespace (packs/relationship.pack.json). */
export const RELATIONSHIP_PREDICATE_PREFIX = 'relationship__';

/** A said state with no stated span is taken to hold about a day. */
const STATE_SHELF_LIFE_MS = 24 * 3600_000;

export interface RelationshipFactRow {
  id: unknown;
  predicate: string;
  object: string;
  validFrom: string | Date;
  expectedUntil?: string | Date | null;
  /** The entity the fact is about — who promised, for a commitment. */
  about?: string | null;
  /**
   * The day the value refers to, as the extractor resolved it
   * (`objectMeta.date`) — for a commitment, the day it is for.
   */
  scheduledDay?: string | null;
}

export interface RelationshipItem {
  factId: string;
  text: string;
  /** Who it is about: the person, or whoever made a commitment. */
  about?: string;
  since: string;
}

export interface RelationshipCommitment extends RelationshipItem {
  /** When it was due, when the turn said. */
  due?: string;
  /** Due and not closed — the agent owes it. */
  overdue: boolean;
}

export type RelationshipState =
  | {
      known: true;
      factId: string;
      text: string;
      saidAt: string;
      ageHours: number;
      holdsUntil: string;
    }
  | {
      /** Nothing said, or what was said has run past its span. */
      known: false;
      last?: { factId: string; text: string; saidAt: string; ageHours: number };
    };

export interface RelationshipContext {
  userId: string;
  name?: string;
  asOf: string;
  boundaries: RelationshipItem[];
  tone: RelationshipItem | null;
  openThreads: RelationshipItem[];
  commitments: RelationshipCommitment[];
  state: RelationshipState;
  whatHelped: RelationshipItem[];
  whatDidNotHelp: RelationshipItem[];
  /**
   * Guesses put to the person (never facts about them): still open, or
   * closed by their own answer — a rejected one is not to be put again.
   */
  hypotheses: {
    open: RelationshipItem[];
    confirmed: RelationshipItem[];
    rejected: RelationshipItem[];
  };
}

const iso = (v: string | Date): string => new Date(v).toISOString();

function item(row: RelationshipFactRow): RelationshipItem {
  return {
    factId: String(row.id),
    text: row.object,
    ...(row.about ? { about: row.about } : {}),
    since: iso(row.validFrom),
  };
}

const local = (predicate: string): string =>
  predicate.startsWith(RELATIONSHIP_PREDICATE_PREFIX)
    ? predicate.slice(RELATIONSHIP_PREDICATE_PREFIX.length)
    : predicate;

export function shapeRelationshipContext(p: {
  userId: string;
  name?: string | undefined;
  rows: readonly RelationshipFactRow[];
  now: Date;
}): RelationshipContext {
  // Newest first, whatever order the read returned.
  const rows = [...p.rows].sort(
    (a, b) => new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime(),
  );
  const of = (predicate: string) => rows.filter((r) => local(r.predicate) === predicate);
  const now = p.now.getTime();

  const commitments = of('commitment').map((r): RelationshipCommitment => {
    const due = dueOf(r);
    return {
      ...item(r),
      ...(due ? { due: due.toISOString() } : {}),
      overdue: due !== undefined && due.getTime() < now,
    };
  });
  // What is owed comes first.
  commitments.sort((a, b) => Number(b.overdue) - Number(a.overdue));

  const tone = of('tone_preference')[0];
  return {
    userId: p.userId,
    ...(p.name ? { name: p.name } : {}),
    asOf: p.now.toISOString(),
    boundaries: of('instruction').map(item),
    tone: tone ? item(tone) : null,
    openThreads: of('open_thread').map(item),
    commitments,
    state: stateOf(of('stated_affect')[0], now),
    whatHelped: of('helped').map(item),
    whatDidNotHelp: of('did_not_help').map(item),
    hypotheses: hypothesesOf(of),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Words every hypothesis row carries whatever it is about. */
const HYPOTHESIS_FILLER = new Set([
  'coach',
  'coach’s',
  "coach's",
  'hypothesis',
  'hypothesized',
  'hypothesizes',
  'that',
]);

function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}’']+/gu) ?? [];
  return new Set(words.filter((w) => w.length >= 4 && !HYPOTHESIS_FILLER.has(w)));
}

/** Most of the open guess's words are in the closing row: the same guess, answered. */
function sameGuess(open: Set<string>, closing: Set<string>): boolean {
  if (open.size === 0) return false;
  let shared = 0;
  for (const w of open) if (closing.has(w)) shared++;
  return shared / open.size >= 0.6;
}

/**
 * A guess the person answered is not open any more. Extraction writes the
 * guess and its answer as separate rows, often from one conversation, so
 * the battery saw the same "snacks more at night on meeting days" both
 * open and rejected (r8, 2026-10-27) and an agent reading `open` would put
 * a rejected guess again. An open row stays only when no confirmation or
 * rejection says the same thing — or when it was raised again more than a
 * day after that answer.
 */
function hypothesesOf(
  of: (predicate: string) => RelationshipFactRow[],
): RelationshipContext['hypotheses'] {
  const confirmed = of('hypothesis_confirmed');
  const rejected = of('hypothesis_rejected');
  const closings = [...confirmed, ...rejected].map((r) => ({
    words: contentWords(r.object),
    at: new Date(r.validFrom).getTime(),
  }));
  const open = of('hypothesis').filter((r) => {
    const words = contentWords(r.object);
    const at = new Date(r.validFrom).getTime();
    return !closings.some((c) => sameGuess(words, c.words) && at - c.at <= DAY_MS);
  });
  return {
    open: open.map(item),
    confirmed: confirmed.map(item),
    rejected: rejected.map(item),
  };
}

/**
 * When a commitment falls due: the expectation the extractor gave it, else
 * the end of the day it is for ("on Thursday I'll ask" is owed through
 * Thursday). A day that is not after the promise is when it was made, not
 * when it is for.
 */
function dueOf(r: RelationshipFactRow): Date | undefined {
  if (r.expectedUntil) return new Date(r.expectedUntil);
  const day = r.scheduledDay ? new Date(`${r.scheduledDay}T00:00:00Z`) : undefined;
  if (!day || Number.isNaN(day.getTime())) return undefined;
  const endOfDay = new Date(day.getTime() + 24 * 3600_000);
  return endOfDay.getTime() > new Date(r.validFrom).getTime() ? endOfDay : undefined;
}

/**
 * The person's state as they last said it — known only while it holds:
 * until the span the turn gave, else about a day. Past that the memory
 * says it does not know, and shows how old the last word is.
 */
function stateOf(row: RelationshipFactRow | undefined, now: number): RelationshipState {
  if (!row) return { known: false };
  const saidAt = new Date(row.validFrom).getTime();
  const holdsUntil = row.expectedUntil
    ? new Date(row.expectedUntil).getTime()
    : saidAt + STATE_SHELF_LIFE_MS;
  const ageHours = Math.round(((now - saidAt) / 3600_000) * 10) / 10;
  const said = { factId: String(row.id), text: row.object, saidAt: iso(row.validFrom), ageHours };
  if (holdsUntil <= now) return { known: false, last: said };
  return { known: true, ...said, holdsUntil: new Date(holdsUntil).toISOString() };
}
