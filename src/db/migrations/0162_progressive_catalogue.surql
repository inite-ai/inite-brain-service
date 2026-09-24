-- 0162_progressive_catalogue — progressive indexing
-- (docs/roadmap/raw-evidence-sources-2026-09.md, W6).
--
-- Doctrine 5: "manifest always, content by policy". A connection whose
-- `contentPolicy` is `manifest` catalogues everything and reads nothing
-- — cheap, and useless until something asks. This adds the three
-- columns that make "a retrieval hit on a manifest-only item schedules
-- its deepening" a fact rather than a sentence:
--
--   * hitCount / lastHitAt — how often a query matched this row's title
--     or path. A hit is NOT a read: it is the evidence that reading
--     would have been worth it.
--   * deepenedAt — the row was fetched on demand. A second hit on an
--     already-deepened row queues nothing; the ordinary revision diff
--     keeps it current from then on.
--
-- No new index: the deepening probe is bounded by connection and state,
-- which `source_item_conn_idx` + `source_item_state_idx` (0156) already
-- serve, and every mutation pre-selects ids (LET → UPDATE), never an
-- UPDATE … WHERE on a compound (the 3.2.4 planner gotcha).

DEFINE FIELD IF NOT EXISTS hitCount ON source_item TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS lastHitAt ON source_item TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS deepenedAt ON source_item TYPE option<datetime>;
