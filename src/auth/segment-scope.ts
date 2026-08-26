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
