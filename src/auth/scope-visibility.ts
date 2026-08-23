/**
 * Scope-tag visibility (G6 step 2, docs/roadmap/sota-gap-build-2026-08.md).
 *
 * The read-side evaluator for the scope-tag model, gated behind
 * `SCOPE_TAGS_ENABLED` (default off). The load-bearing safety property:
 * when the flag is ON the evaluator runs as an ADDITIONAL fence
 * ALONGSIDE the existing `userId` filter (migration 0055), never as a
 * replacement — a row must pass BOTH. Composed with AND, the flag can
 * only ever NARROW what the userId filter already returns, so enabling
 * it can never OPEN access that userId filtering closed. For current
 * single-tag data the two fences keep provably identical row sets (see
 * scope-tags-parity.e2e-spec.ts), which is what makes shipping it
 * enabled safe.
 *
 * Pure evaluator + a request-context-derived principal + a SQL-fragment
 * helper for the seams whose userId fence is a WHERE clause.
 */
import { envFlagEnabled } from '../common/env-validation';
import { getRequestContext } from '../common/request-context';
import { parseTag, userTag } from './scope-tags';

/**
 * A principal that holds tenant-wide authority (an M2M credential with
 * no end-user identity, or a background/internal context). It sees every
 * row in the tenant, matching today's behavior where such a caller has
 * no `userId` ownership fence applied. Represented as an explicit symbol
 * — never a magic string — so it can never collide with a real tag.
 */
export const TENANT_WIDE: unique symbol = Symbol('scope.tenant_wide');

/** A principal is either tenant-wide, or a concrete set of held tags. */
export type PrincipalScope = typeof TENANT_WIDE | readonly string[];

/** Whether the scope-tag fence is active. Read per-call (runtime-mutable). */
export function scopeTagsEnabled(): boolean {
  return envFlagEnabled(process.env.SCOPE_TAGS_ENABLED);
}

/**
 * Does `principal` satisfy a record whose `recordScope` is ONE AND-set
 * clause? OR-of-ANDs, restricted to the one-clause-per-record shape of
 * step-1 data:
 *   - empty record scope (`[]`) → tenant-global, visible to everyone in
 *     the tenant (matches `userId IS NONE`);
 *   - a tenant-wide principal (M2M) → sees every row, unconditionally;
 *   - otherwise the principal must hold ALL of the clause's tags
 *     (`clause ⊆ principalTags`). Step-1 records carry exactly one tag,
 *     so this reduces to "the principal holds that tag".
 *
 * FAIL CLOSED: any tag in the record scope that is unparseable or of an
 * unknown namespace hides the record from a scoped principal — an
 * unrecognized tag is never treated as absent (which would default the
 * record open). A tenant-wide principal is the tenant boundary itself
 * and still sees such rows, so enabling the flag never hides data an
 * M2M caller sees today (the parity property, extended to malformed
 * tags).
 */
export function visibleUnderScope(
  recordScope: readonly string[],
  principal: PrincipalScope,
): boolean {
  // Tenant-global content: visible to everyone in the tenant.
  if (recordScope.length === 0) return true;
  // Tenant-wide authority: sees the whole tenant, malformed tags included
  // (it already does today, with no userId fence) — preserves parity.
  if (principal === TENANT_WIDE) return true;
  // Scoped principal: satisfy the AND-set, failing closed on any tag we
  // cannot parse or whose namespace we do not recognize.
  for (const tag of recordScope) {
    if (parseTag(tag) === null) return false;
    if (!principal.includes(tag)) return false;
  }
  return true;
}

/**
 * The tags the current request's principal holds, derived from the ALS
 * request context (the same source `pinUserScope` reads):
 *   - a user-bound token (authUserId set by ApiKeyGuard) → `['user:<id>']`;
 *   - an M2M credential or a background context (no authUserId) →
 *     TENANT_WIDE.
 *
 * Mirrors `pinUserScope(undefined)`: where that returns the token's
 * end-user (fencing reads) or undefined (unrestricted), this returns the
 * held tag set or TENANT_WIDE.
 */
export function principalScopeTags(): PrincipalScope {
  const authUserId = getRequestContext()?.authUserId;
  return authUserId ? [userTag(authUserId)] : TENANT_WIDE;
}

/**
 * The SQL fence for the seams whose userId filter is a WHERE clause
 * (episode L0 reads, fact search legs). Returns an ADDED AND-condition
 * that mirrors the `userId` filter tag-for-tag against the `scope`
 * column, or an empty fragment when the flag is off (fully inert — the
 * userId filter stays the sole enforcement). Never rewrites the userId
 * filter; it is only ever appended.
 *
 * Derived from the SAME scoped `userId` that drives the userId filter,
 * so parity is structural: for step-1 data where `scope` mirrors
 * `userId`, the added clause keeps exactly the rows the userId clause
 * keeps. Fail-closed by construction — a row whose scope is neither `[]`
 * nor the principal's single `user:<id>` tag matches neither branch and
 * is hidden.
 *
 * @param userId the request's scoped end-user (undefined = tenant-global)
 * @param param  bound-parameter name to use for the principal tag
 */
export function scopeFenceSql(
  userId: string | undefined,
  param = 'principalScopeTag',
): { clause: string; params: Record<string, unknown> } {
  if (!scopeTagsEnabled()) return { clause: '', params: {} };
  if (!userId) {
    // No scoped user → tenant-global only, mirroring `userId IS NONE`.
    return { clause: 'AND scope = []', params: {} };
  }
  return {
    clause: `AND (scope = [] OR scope = [$${param}])`,
    params: { [param]: userTag(userId) },
  };
}
