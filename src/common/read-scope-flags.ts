import { envFlagNotDisabled } from './env-validation';

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
 * runtime-mutable (no restart).
 *
 * DEFAULT ON since 2026-09-12. Off, the two surfaces answer EMPTY for
 * any deployment that writes per-user memory — which is what a stock
 * install does the moment a caller passes a userId. Measured on the
 * memory-fitness battery: the evolution dimension scored 0/3 with
 * "no queue_backend events matched either value" while the timeline
 * held both values, and the conflict dimension could not see a
 * `competing` pair that was sitting on the entity. Neither surface was
 * broken; both were fenced away from the rows.
 *
 * Widening is not a privilege escalation: the added clause admits ONLY
 * `userId = $scopeUserId`, and `pinUserScope` resolves that to the
 * token's own end-user (403 on a mismatch) or to nothing at all for an
 * M2M token that named no user — in which case the historical
 * tenant-global clause still applies, byte-identical. Clearing the flag
 * restores the pre-0055 fence.
 *
 * READ_ sits off the ENGINE flag budget by design (an authz read
 * fence, not an engine fork).
 */
export function readSurfaceUserScopeEnabled(): boolean {
  return envFlagNotDisabled(process.env.READ_SURFACE_USER_SCOPE);
}
