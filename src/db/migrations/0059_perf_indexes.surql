-- 0059_perf_indexes — indexes for scans found by the 2026-07 performance audit.
--
-- knowledge_fact.supersededBy / .derivedFrom:
--   FactsService retract cascade runs `WHERE derivedFrom CONTAINS $id` once
--   per cascaded fact and `WHERE supersededBy = $id` once per revive — both
--   were full table scans on the DELETE /v1/facts/:id and MCP retract_fact
--   hot path. derivedFrom is an array field; the index covers per-element
--   lookups the same way entity_aliases_idx does.
--
-- knowledge_fact.retractedAt / .validUntil:
--   The nightly compaction candidate scan filters on both, and memory_diff
--   filters on retractedAt — full scans of the largest table in the system.
--
-- retrieval_feedback.createdAt:
--   The nightly source-trust refit does `ORDER BY createdAt DESC LIMIT 50000`
--   per tenant with only factId indexes present — full scan + sort of a table
--   that grows with every feedback event.
--
-- knowledge_edge.invalidatedAt:
--   Community builder and edge maintenance filter live edges with
--   `invalidatedAt IS NONE` over the whole edge table.

DEFINE INDEX IF NOT EXISTS fact_superseded_by_idx ON knowledge_fact FIELDS supersededBy;
DEFINE INDEX IF NOT EXISTS fact_derived_from_idx  ON knowledge_fact FIELDS derivedFrom;
DEFINE INDEX IF NOT EXISTS fact_retracted_idx     ON knowledge_fact FIELDS retractedAt;
DEFINE INDEX IF NOT EXISTS fact_valid_until_idx   ON knowledge_fact FIELDS validUntil;

DEFINE INDEX IF NOT EXISTS retrieval_feedback_created_idx ON retrieval_feedback FIELDS createdAt;

DEFINE INDEX IF NOT EXISTS edge_invalidated_idx ON knowledge_edge FIELDS invalidatedAt;
