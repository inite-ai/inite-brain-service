import { envFlagEnabled } from './env-validation';

/**
 * PRIVACY_ flag family — data-protection fences, not engine forks.
 *
 * The family name is deliberate: segment/synthesize-adjacent names
 * starting SEARCH_/SYNTHESIZE_ would land on the ENGINE flag budget
 * (test/flag-budget.unit-spec.ts), and SCOPE_ is taken conceptually by
 * the 0093 tag-grammar work (SCOPE_TAGS_ENABLED, auth family). These
 * flags gate security fences over already-existing read seams; they
 * fork no engine behavior, so they sit off the budget by design.
 *
 * Both flags default OFF for the byte-identity house rule ONLY — they
 * are security fixes and .env.example ships them ON with the operator
 * order (backfill FIRST on an existing deployment, then flip). A future
 * release flips the code default to ON after one release of backfill
 * soak (docs/roadmap/privacy-user-fence-2026-08.md).
 */

/**
 * PRIVACY_SEGMENT_USER_FENCE — per-member user scope fence for verbatim
 * windows (episode_segment, migration 0117).
 *
 * When on, the four segment read seams (segment lane transcript +
 * anchors, fused search leg, mention scan) admit a user-scoped caller to
 * a userId-NONE window ONLY when the persisted `userIds` member set is
 * [] (purely tenant-global) or CONTAINS the caller (window membership —
 * co-present verbatim is re-disclosure, not disclosure). FAIL-CLOSED:
 * a legacy row with `userIds IS NONE` (pre-backfill) is hidden from
 * user-scoped callers until the backfill stamps it — operator order is
 * migrate → POST /v1/admin/maintenance/segments/backfill-user-ids →
 * flip this fence. Tenant-global (M2M) callers are unchanged either
 * way. The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2); read at call time so a flip is
 * runtime-mutable (no restart). Default off ⇒ the seams keep their
 * exact pre-0117 WHERE strings — byte-identical served behavior.
 */
export function privacySegmentUserFenceEnabled(): boolean {
  return envFlagEnabled(process.env.PRIVACY_SEGMENT_USER_FENCE);
}

/**
 * PRIVACY_COMPOSER_USER_SCOPE — deriver-idiom user scope rule for the
 * write-time insight composers (aggregates, arcs; shared kernel).
 *
 * When on, each valid proposal folds the distinct userIds of its member
 * facts (deriver drop idiom, derive-row-builder.ts): 0 users → global
 * row (unchanged); exactly 1 → the composed row is stamped userId +
 * scope so the 0055/0093 read fences apply to it; ≥2 → the proposal is
 * DROPPED (warned + counted) — a cross-user summary must never become a
 * tenant-global row readable by every user. The env read lives here in
 * the common layer, NOT inside the engine dirs (engine-gates S5.2);
 * read at call time so a flip is runtime-mutable. Default off ⇒
 * composed rows are byte-identical (no userId/scope stamp, no drops).
 */
export function privacyComposerUserScopeEnabled(): boolean {
  return envFlagEnabled(process.env.PRIVACY_COMPOSER_USER_SCOPE);
}
