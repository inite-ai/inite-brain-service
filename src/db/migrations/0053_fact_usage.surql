-- 0053_fact_usage — usage-based reinforcement, storage side.
--
-- Until now retrieval never fed back into memory: decay counted only
-- from recordedAt, so a fact the tenant's agents touch every day aged
-- exactly like one nobody ever asked about. This table records "this
-- fact was surfaced by search" so the read path can restart the decay
-- clock at the most recent retrieval (SEARCH_USAGE_DECAY_ENABLED).
--
-- A SEPARATE table, not fields on knowledge_fact, deliberately:
--   * knowledge_fact sits on a CHANGEFEED mirrored into audit_event —
--     per-search counter bumps would flood the audit trail;
--   * knowledge_artifact has a DEFINE EVENT that marks artifacts dirty
--     on ANY fact change — usage stamps would recompile artifacts for
--     nothing;
--   * the ingest path serializes fact writes per (entity, predicate)
--     through a KeyedMutex — read-path writes must not contend there.
--
-- Rows are written fire-and-forget by the search pipeline
-- (SEARCH_USAGE_RECORDING_ENABLED), one row per fact, deduped by the
-- UNIQUE factId index (INSERT … ON DUPLICATE KEY UPDATE). GDPR forget
-- cascades over factId BEFORE the facts themselves are deleted.

DEFINE TABLE IF NOT EXISTS fact_usage SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS factId     ON fact_usage TYPE record<knowledge_fact>;
DEFINE FIELD IF NOT EXISTS readCount  ON fact_usage TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS lastReadAt ON fact_usage TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS fact_usage_fact_idx ON fact_usage FIELDS factId UNIQUE;
