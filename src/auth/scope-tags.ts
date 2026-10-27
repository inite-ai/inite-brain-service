/**
 * Scope-tag grammar (G6 step 1, docs/roadmap/sota-gap-build-2026-08.md).
 *
 * Generalizes the single per-user scope key (migration 0055's `userId`)
 * into a tag model that later steps extend to org/team membership. A
 * scope tag is `<namespace>:<id>`. Today the ONLY namespace stamped on
 * data is `user`; `org`/`team` are RESERVED here so the parser accepts
 * them the moment steps 3-5 (ABAC widen / share-up / revocation) start
 * writing them, but no code emits them yet.
 *
 * A record's `scope` column is an array of tags interpreted as ONE
 * AND-set clause (the record requires ALL its tags to be satisfied).
 * For step-1 data every record carries exactly ONE tag (`user:<id>`) or
 * an empty array (tenant-global). Visibility (`visibleUnderScope`, in
 * scope-visibility.ts) is the OR-of-ANDs evaluation that the multi-tag /
 * multi-clause shapes of later steps generalize to.
 *
 * Pure module — no NestJS, no DB, no request context. Importable from
 * services, pure internals, and SQL-fragment builders alike.
 */
import { ambientWriteScope } from './write-scope';

/** Active namespace: a single end-user's slice of the tenant (0055). */
export const USER_NAMESPACE = 'user';
/** Reserved for step 3+ (ABAC org widen). No writer emits it in step 1. */
export const ORG_NAMESPACE = 'org';
/** Reserved for step 3+ (team membership). No writer emits it in step 1. */
export const TEAM_NAMESPACE = 'team';

/**
 * Namespaces the grammar recognizes. A tag whose namespace is NOT in
 * this set is treated as UNPARSEABLE by `parseTag` (→ fail-closed in the
 * evaluator) — an unknown namespace must never default a record open.
 */
export const KNOWN_NAMESPACES: ReadonlySet<string> = new Set([
  USER_NAMESPACE,
  ORG_NAMESPACE,
  TEAM_NAMESPACE,
]);

export interface ParsedTag {
  namespace: string;
  id: string;
}

/** The scope tag for a single end-user: `user:<userId>`. */
export function userTag(userId: string): string {
  return `${USER_NAMESPACE}:${userId}`;
}

/**
 * Parse a scope tag into `{ namespace, id }`, or `null` when the tag is
 * malformed OR carries an unknown namespace. Splitting on the FIRST
 * colon lets an id itself contain colons (record ids do). A null return
 * is the fail-closed signal the evaluator keys on: an unparseable tag in
 * a record scope hides that record from a scoped principal.
 */
export function parseTag(tag: string): ParsedTag | null {
  if (typeof tag !== 'string') return null;
  const sep = tag.indexOf(':');
  // Reject: no separator, empty namespace, empty id.
  if (sep <= 0 || sep === tag.length - 1) return null;
  const namespace = tag.slice(0, sep);
  const id = tag.slice(sep + 1);
  if (!KNOWN_NAMESPACES.has(namespace)) return null;
  return { namespace, id };
}

/**
 * The record scope for a write attributed to `userId`:
 *   - a defined userId → `['user:<userId>']` (the one-clause AND-set);
 *   - undefined → `[]` (tenant-global, the `userId IS NONE` meaning).
 *
 * This is the single place a per-user write turns into a scope, so the
 * org/team extension of later steps has one call site to widen.
 */
export function scopeForUser(userId: string | undefined): string[] {
  if (userId) return [userTag(userId)];
  // Step 3: an ingest may declare the scope its tenant-global writes
  // belong to (an org connection's group). A user-attributed write is
  // never widened by it — the user's own tag still wins above.
  return [...(ambientWriteScope() ?? [])];
}

/**
 * The scope tag for one group of one connection:
 * `team:<connection>:<group>`. The connection is IN the tag on purpose —
 * "the engineering group" means nothing tenant-wide, and two
 * connections to two GitLabs may both have a group called `developers`.
 *
 * ⚡`<connection>` is the record id's TAIL, never the whole
 * `source_connection:xyz`: a record id contains a colon, and a tag with
 * two variable-length colon-separated parts cannot be parsed back. The
 * tail is unique within its table, which is all a tag needs — and
 * `parseTeamTag` returns it as `connection`, so no caller mistakes it
 * for a record id.
 */
export function teamTag(connectionId: string, group: string): string {
  return `${TEAM_NAMESPACE}:${idTail(connectionId)}:${group}`;
}

/** The tail of a record id (`source_connection:abc` → `abc`). */
function idTail(id: string): string {
  const sep = id.indexOf(':');
  return sep >= 0 ? id.slice(sep + 1) : id;
}

export interface ParsedTeamTag {
  /** The connection's record-id TAIL, not the record id. */
  connection: string;
  group: string;
}

/**
 * `team:<connection>:<group>` → its two halves, or null. The group may
 * itself contain colons (a source's own id is not ours to constrain);
 * the connection tail may not, and a tag whose tail is empty — or whose
 * group is — is unparseable, which hides its row.
 */
export function parseTeamTag(tag: string): ParsedTeamTag | null {
  const parsed = parseTag(tag);
  if (!parsed || parsed.namespace !== TEAM_NAMESPACE) return null;
  const sep = parsed.id.indexOf(':');
  if (sep <= 0 || sep === parsed.id.length - 1) return null;
  return { connection: parsed.id.slice(0, sep), group: parsed.id.slice(sep + 1) };
}

/**
 * The record scope for a write the source plane makes: the owner's tag
 * when the connection is one person's, else the groups the ITEM says
 * may see it — and, when neither is known, the empty array that means
 * tenant-global.
 *
 * The three cases are not interchangeable and the order matters. A
 * personal connection is user-fenced by construction (0055) and its
 * groups, if the source even has any, are irrelevant: the owner is the
 * only reader. An org connection's row carries EVERY group the item is
 * shared with — an OR of clauses in G6's grammar, which the one-clause
 * AND-set shape cannot express, so the row carries the groups as an
 * AND-set of one when there is exactly one and, when there are several,
 * the narrowest wins: an item shared with two groups is written for the
 * FIRST, and the connector is expected to name the group that owns it.
 * Widening to a real OR is step 4's staging work, not this one, and
 * guessing wider here is precisely the failure this whole plane exists
 * to prevent.
 */
export function scopeForSource(p: {
  userId?: string | undefined;
  connectionId: string;
  groups?: readonly string[] | undefined;
}): string[] {
  if (p.userId) return [userTag(p.userId)];
  const group = (p.groups ?? []).find((g) => typeof g === 'string' && g.length > 0);
  return group === undefined ? [] : [teamTag(p.connectionId, group)];
}
