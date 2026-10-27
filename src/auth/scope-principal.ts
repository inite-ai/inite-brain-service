/**
 * The tags the current request's principal holds, resolved ONCE and
 * read synchronously everywhere after (G6 step 3, W5).
 *
 * The read fences (`scopeFenceSql`, `visibleUnderScope`) are called from
 * SQL builders deep inside search legs and episode reads; they are
 * synchronous by construction and threading a DB round-trip through
 * them is not an option. So the guard resolves the expansion for the
 * request's user up front and leaves it in the ALS request context; the
 * fences read it.
 *
 * Fail-closed by omission: when nothing was warmed — a background job, a
 * request that never passed the guard, the flag off — the fences fall
 * back to the single `user:<id>` tag, which is exactly today's
 * behaviour and is NARROWER than any expansion. A miss can only ever
 * hide rows, never reveal them.
 *
 * Pure module: the resolver itself lives in MembershipService; this is
 * the memo it writes into.
 */
import { getRequestContext } from '../common/request-context';
import { userTag } from './scope-tags';

/** The per-request memo: the expanded tag set of each user we resolved. */
export interface ScopeTagMemo {
  byUser: Map<string, readonly string[]>;
}

export function scopeTagMemo(): ScopeTagMemo | undefined {
  return getRequestContext()?.scopeTags;
}

/** Leave one user's expansion where the synchronous fences can read it. */
export function rememberScopeTags(userId: string, tags: readonly string[]): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  const memo = ctx.scopeTags ?? { byUser: new Map<string, readonly string[]>() };
  memo.byUser.set(userId, tags);
  ctx.scopeTags = memo;
}

/**
 * The tags to fence a read for `userId` with: the resolved expansion
 * when this request warmed one, else the user's own tag alone.
 */
export function heldTagsFor(userId: string): readonly string[] {
  const memo = scopeTagMemo();
  const tags = memo?.byUser.get(userId);
  return tags && tags.length > 0 ? tags : [userTag(userId)];
}
