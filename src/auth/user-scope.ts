/**
 * Per-user memory scope pinning.
 *
 * userId on read/write DTOs is caller-asserted: an M2M credential holds
 * tenant-wide authority and may scope requests to any end-user. A
 * user-bound access token (auth-service token with `org` + `sub`) must
 * NOT — its authority is one user's slice of the tenant. The guard stamps
 * the token's end-user into the ALS request context (authUserId); this
 * helper pins every caller-asserted userId to it at the service entry
 * points, so the enforcement needs no signature threading (same pattern
 * as ABAC row filtering).
 *
 * Pure module — importable from services and pure internals alike.
 */

import { ForbiddenException } from '@nestjs/common';
import { getRequestContext } from '../common/request-context';

/**
 * Resolve the effective per-user scope for a request.
 *
 *  - M2M credential (no authUserId): the caller-asserted value passes
 *    through unchanged — tenant-wide authority, pre-existing behavior.
 *  - User-bound token: the token's user wins. An explicit mismatching
 *    assertion is a 403 (attempt to read/write another user's scope);
 *    an omitted one defaults to the token's user, so a user session
 *    always operates on global + own memory, never global-only writes.
 */
export function pinUserScope(requested: string | undefined): string | undefined {
  const authUserId = getRequestContext()?.authUserId;
  if (!authUserId) return requested;
  if (requested !== undefined && requested !== authUserId) {
    throw new ForbiddenException(
      'userId does not match the authenticated user scope of this token',
    );
  }
  return authUserId;
}
