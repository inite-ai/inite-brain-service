import { envFlagEnabled } from './env-validation';

/**
 * Per-user read scope on the pre-0055 read surfaces —
 * READ_SURFACE_USER_SCOPE.
 *
 * Two read surfaces predate migration 0055's per-user scope and pinned
 * a hardcoded `userId IS NONE` fence: the entity timeline
 * (EntitiesService.getTimeline) and the competing-facts listing
 * (FactsService.listCompeting). Every user-scoped fact was therefore
 * invisible to both — a per-user deployment saw an empty evolution
 * history and an empty adjudication queue no matter what it wrote.
 *
 * When on AND the caller supplies a userId (pinned to a user-bound
 * token's end-user via pinUserScope, the ingestFact idiom — a user
 * token cannot read another user's slice), the fence widens to the
 * search-lane union: `(userId IS NONE OR userId = $scopeUserId)` —
 * tenant-global rows PLUS that one user's rows, never a third user's.
 * The env read lives here in the common layer, NOT inside the read
 * services (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable (no restart). Default off — or on with no userId —
 * keeps the exact historical `userId IS NONE` clause, byte-identical.
 * READ_ sits off the ENGINE flag budget by design (an authz read
 * fence, not an engine fork).
 */
export function readSurfaceUserScopeEnabled(): boolean {
  return envFlagEnabled(process.env.READ_SURFACE_USER_SCOPE);
}
