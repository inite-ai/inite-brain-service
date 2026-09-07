-- 0130: scene_dirty_conversation — the incremental trigger for the
-- scheduled scene-maintenance pass (SCENES_SCHEDULED_MAINTENANCE).
--
-- WHY. The scene composer (0106) had exactly one entry point — the admin
-- route — and it rebuilt EVERY conversation of the tenant from scratch on
-- every call: `SELECT conversationId, count() FROM episode GROUP BY
-- conversationId` (episode-read-store.conversationCounts) is O(all turns
-- ever ingested), and the composer then re-derived scenes for every one of
-- them whether or not a single new turn had landed. That is affordable for
-- an operator pressing a button and unaffordable for a nightly cron: the
-- post-swap chain spends ONE LLM call per NEW scene (SCENES_LLM_ENRICHMENT)
-- and one embedding batch per composed conversation (SCENES_TOPIC_BOUNDARY),
-- so a full nightly rebuild would re-walk the entire corpus to discover the
-- handful of conversations that actually moved.
--
-- WHAT. One tiny row per conversation that has received turns since the
-- last successful scene swap. The ingest seam (EpisodeStoreService
-- .captureTurn — the one place that already knows "this conversation just
-- got a turn") UPSERTs the row; the scheduled pass reads a BOUNDED page of
-- it, composes exactly those conversations, and deletes the rows it
-- consumed. Steady state is therefore proportional to conversations that
-- MOVED, not to conversations that exist.
--
-- ALTERNATIVES CONSIDERED.
--  * A column on an existing table: there is no per-conversation row
--    anywhere in the schema to hang it on. `episode` is per-TURN (a mark
--    smeared over every turn needs an O(turns) clear, and the clear is a
--    WHERE over the indexed conversationId — the 3.2.4 planner hazard);
--    `conversation_digest` (0086) is the window-deriver's own derived world
--    keyed (conversationId, derivedVersion) and hijacking it would put two
--    unrelated lifecycles on one row; `projection` (raw-substrate driver
--    surface 3) is the per-WORLD lifecycle ledger, and per-conversation
--    rows in it would give `status` two meanings in one subsystem — exactly
--    the trap 0106's NAMING NOTES call out. Hence a table of its own: the
--    minimal additive structure, not a preference for new tables.
--  * A derived watermark (compare max(episode.recordedAt) per conversation
--    against the scene world's per-conversation composed-at): needs no
--    write at ingest, but the comparison itself is the O(all conversations)
--    GROUP BY this migration exists to remove.
--  * A changefeed on `episode`: rejected in 0073 on GDPR grounds (a 30-day
--    INCLUDE ORIGINAL feed keeps forgotten turns readable) and that
--    reasoning is unchanged.
--
-- IDENTITY. Record id `scene_dirty_conversation:[<conversationId>]` — the
-- array-literal id idiom (projection:[name, version]): UPSERT-idempotent by
-- PRIMARY KEY, so a burst of turns on one conversation collapses onto one
-- row with no read-modify-write, and the scheduled pass clears by explicit
-- id list. Both the mark and the clear therefore address rows by primary
-- key; no writer in this table's lifecycle issues an UPDATE/DELETE whose
-- WHERE filters a secondary or compound index (the 3.2.4 silent-no-op
-- planner bug documented in 0093 / scene-composer's swap comment).
--
-- RACE CONTRACT. `markedAt` is bumped on every turn. The pass captures a
-- `readAt` instant BEFORE selecting the dirty page and clears only rows
-- still satisfying `markedAt <= readAt` — a turn that lands DURING a long
-- compose bumps markedAt past readAt, the row survives the clear, and the
-- conversation is recomposed on the next pass. Losing a turn is impossible;
-- the worst case is one redundant recompose.
--
-- NO CHANGEFEED (0073/0106 reasoning) and no full-text/vector index: the
-- row carries no content.
--
-- GDPR. Deliberately NOT wired into either forget cascade. The row holds a
-- conversation IDENTIFIER and two timestamps — no turn text, no userId, no
-- derived content — and it is self-clearing: the next successful pass
-- deletes it, and a conversation whose turns were erased simply composes to
-- zero scenes and drops its mark. Nothing here survives that the `episode`
-- rows themselves do not.
--
-- Derived/transient state: dropping the table costs at most one full
-- rebuild via the admin route, which is the pre-0130 behaviour.

DEFINE TABLE IF NOT EXISTS scene_dirty_conversation SCHEMAFULL;

-- Mirrored out of the record id so reads and logs never have to parse it.
DEFINE FIELD IF NOT EXISTS conversationId ON scene_dirty_conversation TYPE string;
-- Bumped on EVERY marking turn — the race fence described above.
DEFINE FIELD IF NOT EXISTS markedAt ON scene_dirty_conversation TYPE datetime;
-- Set once, on create (UPSERT ... SET never restates it): how long this
-- conversation has been waiting for a pass. Pure observability.
DEFINE FIELD IF NOT EXISTS createdAt ON scene_dirty_conversation TYPE datetime
  DEFAULT time::now();

-- Oldest-first page selection for the bounded nightly budget: a big tenant
-- whose backlog exceeds SCENES_MAINTENANCE_MAX_CONVERSATIONS drains in
-- arrival order instead of starving its oldest conversations forever.
DEFINE INDEX IF NOT EXISTS scene_dirty_marked_idx ON scene_dirty_conversation
  FIELDS markedAt;
