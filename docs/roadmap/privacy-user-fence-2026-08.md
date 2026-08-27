# Privacy user fence — mixed-user windows and composer scope (2026-08)

## What shipped (drift2 fix, migration 0117)

Two same-class defects, both "a derived row folded multi-user grounding
into a tenant-global stamp" (the class already fixed twice: the deriver
P0 of 2026-08-21 and the 0087 digest `userScopes` fix):

1. **Mixed-user verbatim windows.** An `episode_segment` (and scene)
   whose member turns belong to ≥2 users folded to `userId = NONE` =
   tenant-global; the distinct member set was computed and DISCARDED.
   Every segment read seam served such windows — verbatim text included
   — to every user-scoped caller. Fixed by persisting the sorted member
   set (`userIds`, 0117) on `episode_segment` + `memory_episode`
   (unconditional write, 0093 precedent) and gating the four read seams
   behind `PRIVACY_SEGMENT_USER_FENCE` through ONE helper
   (`src/auth/segment-scope.ts` `segmentUserGate`): a user-scoped
   caller sees their own rows, plus `userId`-NONE rows whose `userIds`
   is `[]` (purely global) or CONTAINS the caller (per-member
   visibility — co-present verbatim is re-disclosure, not disclosure).
   FAIL-CLOSED on legacy rows (`userIds IS NONE`): backfill first via
   `POST /v1/admin/maintenance/segments/backfill-user-ids`.
   Rejected alternative (documented in the helper): the digest
   exact-match gate — right consent unit for blended digest prose,
   wrong for a verbatim window with precise membership, and it would
   gut dialogue-genre serving for multi-user tenants.

2. **Composer scope.** The insight-composer kernel (aggregates, arcs)
   selected source facts with no `userId` filter and stamped none on
   the composed rows → single-user facts became tenant-global
   `summary_*`/`aggregate_*` rows. Fixed behind
   `PRIVACY_COMPOSER_USER_SCOPE` with the deriver drop idiom at the
   kernel: 0 member users → global; exactly 1 → stamp
   `userId` + `scope`; ≥2 → drop the proposal (warned + counted in
   `ComposerRunResult.droppedCrossUser`).

Both flags are **default OFF in code** (byte-identity house rule; the
exposure paths are themselves default-off) but **shipped ON in
.env.example** with loud catalog warnings — they are security fences.

## Default-flip plan

Flip both code defaults to ON after **one release of backfill soak**:
every existing deployment has run the segment backfill (and a scene
composer re-run where scenes are built), and no
`droppedCrossUser`-driven regressions surfaced. Until then the
.env.example + config-catalog WARNING carry the operator order:
migrate 0117 → backfill → flip fence.

## Follow-ups

- **Per-user composer grouping** (utility, not safety): instead of
  dropping cross-user proposals, group source facts per user and
  compose per-user summaries. Multiplies LLM calls — wants its own
  cost decision. The drop rule stays the safety floor either way.
- **Scenes read contract**: `memory_episode.userIds` is persisted, but
  scenes have no serving readers yet. The 0117 migration header and
  `foldSceneScope` docblock bind future readers to the same
  `segmentUserGate` semantics (fail-closed on NONE). Scene backfill =
  re-run `POST /v1/admin/maintenance/scenes`.
- **GDPR**: no change needed — user-forget already deletes mixed
  segments/scenes WHOLE by episode reference (erasure wins over
  retention); pinned by a source-regex guard so a refactor cannot
  regress it into `userIds` array-editing.
