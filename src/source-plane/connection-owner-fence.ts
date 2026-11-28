/**
 * Who may act on a source connection.
 *
 * A personal connection (`userId` set — `ownerUserId` on the wire) writes
 * every row it produces into its owner's memory, and its catalogue lists
 * the owner's files. A user-bound credential (the guard's `authUserId`)
 * holds one user's slice of the tenant, so it may act only on its own
 * personal connections and on org connections (no owner). A tenant-wide
 * credential (M2M key, background job — no `authUserId`) keeps its
 * tenant-wide authority, exactly as before.
 *
 * Another user's connection answers the same 404 an absent one does —
 * a 403 would confirm it exists.
 *
 * Pure module: reads the ALS request context, the way `pinUserScope`
 * does, so no route has to thread the caller down.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRequestContext } from '../common/request-context';

/** Whether the current caller may see / act on a connection owned by `owner`. */
export function callerMayActOn(row: { userId?: string | null | undefined }): boolean {
  const authUserId = getRequestContext()?.authUserId;
  if (!authUserId) return true;
  return !row.userId || row.userId === authUserId;
}

/** 404 (indistinguishable from absent) unless the caller may act on the connection. */
export function assertCallerMayActOn(row: { userId?: string | null | undefined }): void {
  if (!callerMayActOn(row)) throw new NotFoundException('source connection not found');
}

/**
 * The owner a new connection may be created for: a user-bound credential
 * may create its own personal connections (or org ones), never one owned
 * by — and so writing into the memory of — another user.
 */
export function assertCallerMayOwn(ownerUserId: string | null | undefined): void {
  const authUserId = getRequestContext()?.authUserId;
  if (!authUserId || !ownerUserId || ownerUserId === authUserId) return;
  throw new ForbiddenException(
    'ownerUserId does not match the authenticated user scope of this token',
  );
}
