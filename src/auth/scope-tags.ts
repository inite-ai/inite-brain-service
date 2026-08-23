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
  return userId ? [userTag(userId)] : [];
}
