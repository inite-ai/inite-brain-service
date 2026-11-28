/**
 * The owner and scope an HTTP evidence registration may claim.
 *
 * `userId` and `scope` arrive in the request body. A tenant-wide
 * credential (M2M key — no `authUserId`) holds the tenant's authority
 * and may name any user or tag, as before. A user-bound credential holds
 * one user's slice: its `userId` is pinned to its own (`pinUserScope` —
 * an omitted one defaults to the token's user, a different one is a
 * 403), and a caller-named `scope` may only carry tags the principal
 * holds (`principalScopeTags`: its own `user:` tag plus the groups the
 * guard resolved). Without that check a user-bound key could register an
 * asset into another user's — or another team's — read fence.
 *
 * An omitted `scope` stays omitted: the store derives it from the pinned
 * owner (`scopeForUser`), the same path the MCP upload tool takes.
 *
 * Pure module — reads the ALS request context.
 */
import { ForbiddenException } from '@nestjs/common';
import { TENANT_WIDE, principalScopeTags } from '../auth/scope-visibility';
import { pinUserScope } from '../auth/user-scope';

export function pinEvidenceWriteScope(input: {
  userId?: string | undefined;
  scope?: string[] | undefined;
}): { userId: string | undefined; scope: string[] | undefined } {
  const userId = pinUserScope(input.userId);
  if (input.scope === undefined) return { userId, scope: undefined };
  const held = principalScopeTags();
  if (held === TENANT_WIDE) return { userId, scope: input.scope };
  if (input.scope.some((tag) => !held.includes(tag))) {
    throw new ForbiddenException('scope names a tag this credential does not hold');
  }
  return { userId, scope: input.scope };
}
