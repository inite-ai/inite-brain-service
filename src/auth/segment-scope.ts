import { privacySegmentUserFenceEnabled } from '../common/privacy-flags';

/**
 * Per-member user-scope gate for verbatim window reads (episode_segment,
 * migration 0117) — the ONE place the four segment read seams (segment
 * lane transcript + anchors, fused search leg, mention scan) build their
 * userId WHERE fragment. Sibling of scope-visibility.ts: an env-keyed
 * security fence spliced into WHERE clauses.
 *
 * THE DEFECT THIS CLOSES: a multi-turn window whose member turns belong
 * to two or more users folds to userId = NONE (tenant-global), so the
 * legacy `userId IS NONE OR userId = $scopeUserId` gate served a mixed
 * A+B window — verbatim text included — to EVERY user-scoped caller C
 * in the tenant.
 *
 * Fence ON semantics (PRIVACY_SEGMENT_USER_FENCE), per-member
 * visibility — a user-scoped caller sees:
 *   - their own single-user rows (userId = $scopeUserId), plus
 *   - userId-NONE rows whose persisted `userIds` member set is []
 *     (purely tenant-global) or CONTAINS the caller. A window holding
 *     A's turn was rendered to A's client when it happened (co-present
 *     turns, same conversation) — serving it back to A is
 *     RE-disclosure; serving it to non-member C is the leak, and
 *     CONTAINS closes exactly that and nothing more.
 *   - FAIL-CLOSED on legacy rows: `userIds IS NONE` (pre-backfill) is
 *     hidden — even a genuinely tenant-global NONE row MAY be mixed, so
 *     treating NONE as global would re-open the hole. Operator order:
 *     migrate 0117 → backfill → flip the fence.
 * A tenant-global caller (no userId — M2M / tenant-wide authority) is
 * unchanged in every mode: it keeps `userId IS NONE` and its
 * fact-search behavior (the digest policy: the tenant boundary itself,
 * mixed rows included, is the M2M surface).
 *
 * REJECTED ALTERNATIVE (deliberate, documented): the 0087 digest
 * exact-match gate (`userScopes = [$u]`), which hides mixed rows from
 * ALL user-scoped callers. Right for digests — blended narrative prose
 * whose per-user attribution is unrecoverable — but the wrong consent
 * unit for a verbatim window with PRECISE membership (userIds is folded
 * from the window's own member turns), and it would silently gut
 * verbatimEvidence/timelineEvidence for every multi-user tenant. The
 * clause lives only here, so switching to exact-match later is a
 * one-line change plus test pins.
 *
 * Fence OFF: returns the EXACT legacy strings, so existing pins and
 * served behavior stay byte-identical.
 */
export function segmentUserGate(userId: string | undefined): {
  clause: string;
  params: Record<string, unknown>;
} {
  if (!userId) {
    // Tenant-global caller: global-only under the legacy gate, global +
    // mixed under none — the fence does not change the M2M surface.
    return { clause: 'AND userId IS NONE', params: {} };
  }
  if (!privacySegmentUserFenceEnabled()) {
    // Legacy fail-closed gate (0055): single-user rows are fenced, but a
    // mixed window (userId IS NONE) is served to every scoped caller.
    return {
      clause: 'AND (userId IS NONE OR userId = $scopeUserId)',
      params: { scopeUserId: userId },
    };
  }
  return {
    clause:
      'AND (userId = $scopeUserId OR (userId IS NONE AND userIds IS NOT NONE AND (array::len(userIds) = 0 OR userIds CONTAINS $scopeUserId)))',
    params: { scopeUserId: userId },
  };
}

/**
 * The 0117 per-member gate for SCENES (memory_episode) — the scene
 * serving lane's user fence (RETRIEVAL_SCENE_LANE).
 *
 * Same per-member semantics as `segmentUserGate`'s fence-ON branch,
 * with two DELIBERATE differences, both tightenings:
 *
 *  1. NOT keyed to PRIVACY_SEGMENT_USER_FENCE. That flag exists to keep
 *     the FOUR pre-existing segment seams byte-identical until an
 *     operator has migrated + backfilled `userIds`; the scene lane has
 *     no legacy behavior to preserve (it is the episodic plane's FIRST
 *     serving reader), so it ships at the strict contract from birth.
 *     Scene rows get `userIds` from the composer at write time
 *     (foldSceneScope), never a backfill — so there is no pre-backfill
 *     window to be lenient about. Fail-closed on `userIds IS NONE` is
 *     therefore the ONLY branch, exactly as scene-segmentation.ts's
 *     read contract binds future readers.
 *  2. SCOPED-USER-ONLY: an unscoped caller (M2M / tenant-wide
 *     authority) gets NO scenes at all rather than the tenant-global
 *     surface segmentUserGate hands it. Callers must enforce this
 *     BEFORE issuing any query — this function throws no opinion on an
 *     absent userId, it simply has no clause to build (see the
 *     lane's fence 2, which returns EMPTY without a single query).
 *
 * A scene is a multi-turn window of verbatim-derived text, so the
 * consent unit is the same as a segment's: a scene holding A's turn was
 * rendered to A when it happened, and serving it back to A is
 * RE-disclosure; serving it to non-member C is the leak.
 */
export function sceneUserGate(userId: string): {
  clause: string;
  params: Record<string, unknown>;
} {
  return {
    clause:
      'AND (userId = $scopeUserId OR (userId IS NONE AND userIds IS NOT NONE AND (array::len(userIds) = 0 OR userIds CONTAINS $scopeUserId)))',
    params: { scopeUserId: userId },
  };
}

/** One scene row's user-scope stamp, as the JS re-check reads it. */
export interface SceneScopeStamp {
  userId?: unknown;
  userIds?: unknown;
}

/**
 * JS re-check of `sceneUserGate`, fail-closed — the read-API doctrine
 * (beliefVisible's sibling): defense in depth over the SQL fence, so an
 * out-of-contract row the WHERE let through never renders.
 *
 * Visible to `userId` when EITHER
 *   - the row is single-user and that user IS the caller, OR
 *   - the row is tenant-global (`userId` absent/NONE) AND carries a
 *     persisted `userIds` ARRAY that is empty or contains the caller.
 * Everything else is hidden: a blank/missing `userId` stamp with a
 * missing `userIds` (the 0117 legacy row), a non-array `userIds`, a
 * non-string `userId`, or a member set that excludes the caller.
 */
export function sceneVisibleToUser(row: SceneScopeStamp, userId: string): boolean {
  const owner = row.userId;
  if (typeof owner === 'string' && owner !== '') return owner === userId;
  // Tenant-global (or an unstamped owner): admit ONLY on a persisted
  // member set — `userIds IS NONE` is hidden, never treated as global.
  if (owner !== undefined && owner !== null) return false;
  const members = row.userIds;
  if (!Array.isArray(members)) return false;
  return members.length === 0 || members.includes(userId);
}
