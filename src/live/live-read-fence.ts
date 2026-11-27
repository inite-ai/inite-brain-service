/**
 * The read fence of one live subscriber, resolved ONCE at subscribe time.
 *
 * Every documented read applies three fences to a fact row: the per-user
 * `userId` fence (`userReadFence`), the scope-tag / trust-circle fence
 * (`scopeFenceSql` / `visibleUnderScope`) and the row policy (predicate
 * scope gate + ABAC, `makeRowPolicyFilter`). All three read the ALS request
 * context. A live event is pushed long after the subscribing request
 * returned — and on whatever async stack the tenant channel's socket was
 * opened on, which is the FIRST subscriber's request. Reading ALS at push
 * time would therefore fence every subscriber with nobody's identity, or
 * with someone else's. So the identity is resolved here, inside the
 * subscribing request, into plain data, and `liveRowVisible` is a pure
 * function of that data and the row.
 *
 * Before this existed the stream fenced only on the predicate scope gate:
 * every fact write in the tenant — other users' personal facts, a circle's
 * rows — was pushed to any `brain:read` subscriber.
 */
import { pinUserScope } from '../auth/user-scope';
import {
  scopeFenceActive,
  TENANT_WIDE,
  visibleUnderScope,
  type PrincipalScope,
} from '../auth/scope-visibility';
import { heldTagsFor } from '../auth/scope-principal';
import { actingCircleTags } from '../auth/circle-scope';
import {
  getCorrelationId,
  getPolicyContext,
  getPolicyRowRecorder,
  getRequestContext,
} from '../common/request-context';
import { readSurfaceUserScopeEnabled } from '../common/read-scope-flags';
import type { PolicyContext } from '../policy/policy.types';
import type { PolicyFilterableRow, RowDecisionSummary } from '../policy/row-filter';

export interface LiveReadFence {
  /**
   * The one end user whose personal rows this subscriber may read, or
   * undefined = tenant-global rows only (`userReadFence`'s two branches).
   */
  userId: string | undefined;
  /**
   * The scope-tag principal, or null when the scope fence was inactive for
   * the subscribing request (`scopeFenceActive()` false). A circle-bound
   * credential never resolves to TENANT_WIDE here — it holds its circle.
   */
  principal: PrincipalScope | null;
  /** The subscriber's ABAC context; null = no policies on its key. */
  policy: PolicyContext | null;
  /** The subscriber's row-decision recorder (bound by the guard with `policy`). */
  recordPolicyRows: ((summary: RowDecisionSummary) => void) | undefined;
  /** The subscribing request's id, so decision records point back at it. */
  correlationId: string | undefined;
}

/**
 * Resolve the subscriber's fence from the CURRENT request context. Must be
 * called inside the subscribing request. Throws 403 (via `pinUserScope`)
 * when a user-bound token names another user.
 */
export function captureLiveReadFence(requestedUserId: string | undefined): LiveReadFence {
  // Pinned even when READ_SURFACE_USER_SCOPE is cleared, so a user-bound
  // token naming someone else is refused either way; cleared, the fence
  // narrows to tenant-global rows exactly as `userReadFence` does.
  const pinned = pinUserScope(requestedUserId);
  const userId = readSurfaceUserScopeEnabled() ? pinned : undefined;
  return {
    userId,
    principal: capturePrincipal(userId),
    policy: getPolicyContext() ?? null,
    recordPolicyRows: getPolicyRowRecorder(),
    correlationId: getCorrelationId(),
  };
}

/**
 * The principal `scopeFenceSql` fences a read for: the scoped user's held
 * tags (bound to the acting circle), else the acting circle's tags for a
 * circle-bound credential that named no one, else tenant-wide authority.
 */
function capturePrincipal(userId: string | undefined): PrincipalScope | null {
  if (!scopeFenceActive()) return null;
  const scoped = userId ?? getRequestContext()?.authUserId;
  if (scoped) return [...heldTagsFor(scoped)];
  const acting = actingCircleTags();
  if (acting.length > 0) return [...acting];
  return TENANT_WIDE;
}

/** The fields of a pushed `knowledge_fact` row the fences read. */
export interface LiveFenceRow extends PolicyFilterableRow {
  userId?: string | null;
  /** `array<string>` in the schema; typed loosely because the fence fails closed on any other shape. */
  scope?: unknown;
}

/**
 * The user and scope-tag fences for one row — the same verdict the SQL
 * fences give the documented reads. The row policy (predicate scope gate +
 * ABAC) is applied separately by the caller with `fence.policy`.
 */
export function liveRowVisible(fence: LiveReadFence, row: LiveFenceRow): boolean {
  // userReadFence: `userId IS NONE` [OR `userId = $scopeUserId`].
  const owner = row.userId ?? null;
  if (owner !== null && owner !== fence.userId) return false;
  if (fence.principal === null) return true;
  // TENANT_WIDE is only captured without an acting circle, where
  // `visibleUnderScope` answers true for every row; deciding it here keeps
  // the verdict off whatever ALS context the push happens to run in.
  if (fence.principal === TENANT_WIDE) return true;
  return visibleUnderScope(normaliseScope(row.scope), fence.principal);
}

/**
 * The column is `array<string> DEFAULT []`. Anything else on the payload is
 * not a scope we can read, so it is passed through as one unparseable tag —
 * which `visibleUnderScope` hides from every scoped principal (fail closed).
 */
function normaliseScope(scope: unknown): readonly string[] {
  if (scope === undefined || scope === null) return [];
  if (Array.isArray(scope) && scope.every((t) => typeof t === 'string')) return scope;
  return ['\u0000unreadable'];
}
