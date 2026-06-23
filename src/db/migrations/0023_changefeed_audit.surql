-- 0023_changefeed_audit — surface CHANGEFEED into an auditable stream.
--
-- migration 0002 declared `CHANGEFEED 30d INCLUDE ORIGINAL` on
-- knowledge_entity / knowledge_fact / knowledge_edge but nothing
-- consumed it. The audit flagged this as a P1 disk-leak risk: a
-- 30-day pre-image stream grows linearly with write traffic, the
-- ROCKSDB compaction CPU stalls on the accumulated tombstones, and
-- nobody ever reads the data.
--
-- The project decision was "Write periodic SHOW CHANGES consumer".
-- This migration provides the storage layer:
--
--   - audit_event    — one row per consumed change, keyed by
--                       (table, recordId, ts, op). Carries the
--                       before/after payloads for compliance +
--                       forensic queries. Stored per-tenant inside
--                       the tenant database; the consumer never
--                       cross-pollinates.
--   - changefeed_state — last consumed `versionstamp` per table.
--                         The consumer SELECTs this on each tick,
--                         calls SHOW CHANGES FOR TABLE … SINCE …,
--                         then UPSERTs the new high watermark
--                         under the same tx so a crashed tick
--                         doesn't double-emit.
--
-- Both tables are SCHEMAFULL so an operator querying them gets a
-- discoverable shape; audit_event.payload is FLEXIBLE so the
-- pre/post-image shapes evolve with the source tables without a
-- migration domino.

DEFINE TABLE IF NOT EXISTS audit_event SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS source ON audit_event TYPE string;
-- Allowed values: 'knowledge_entity' | 'knowledge_fact' | 'knowledge_edge'.
-- Kept as string (not enum) so the consumer can be reused for future
-- audited tables without a migration.
DEFINE FIELD IF NOT EXISTS recordId ON audit_event TYPE string;
DEFINE FIELD IF NOT EXISTS op ON audit_event TYPE string;
-- 'create' | 'update' | 'delete' | 'define' — matches SurrealDB's
-- SHOW CHANGES tag set.
DEFINE FIELD IF NOT EXISTS ts ON audit_event TYPE datetime
    DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS versionstamp ON audit_event TYPE int;
-- Optional pre-image (state before the change) — populated for
-- update/delete when CHANGEFEED was defined with INCLUDE ORIGINAL.
DEFINE FIELD IF NOT EXISTS before ON audit_event TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS after ON audit_event TYPE option<object> FLEXIBLE;
-- Lightweight metadata for forensic queries.
DEFINE FIELD IF NOT EXISTS consumedBy ON audit_event TYPE string
    DEFAULT 'changefeed-consumer';

DEFINE INDEX IF NOT EXISTS audit_event_source_ts_idx
    ON audit_event FIELDS source, ts;
DEFINE INDEX IF NOT EXISTS audit_event_record_idx
    ON audit_event FIELDS recordId;

-- ── Consumer position ────────────────────────────────────────────
DEFINE TABLE IF NOT EXISTS changefeed_state SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS source ON changefeed_state TYPE string;
-- Last successfully consumed versionstamp. SHOW CHANGES SINCE this
-- + 1 picks up the next batch.
DEFINE FIELD IF NOT EXISTS lastVersionstamp ON changefeed_state TYPE int
    DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt ON changefeed_state TYPE datetime
    DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS changefeed_state_source_idx
    ON changefeed_state FIELDS source UNIQUE;
