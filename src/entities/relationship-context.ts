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
    const due = r.expectedUntil ? iso(r.expectedUntil) : undefined;
    return {
      ...item(r),
      ...(due ? { due } : {}),
      overdue: due !== undefined && new Date(due).getTime() < now,
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
  };
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
