-- 0105_changefeed_overwrite — re-attach the audit CHANGEFEED on the three
-- knowledge tables for SurrealDB-3.x-first tenants.
--
-- WHY: migration 0002 attached `CHANGEFEED 30d INCLUDE ORIGINAL` to
-- knowledge_entity / knowledge_fact / knowledge_edge via
-- `DEFINE TABLE IF NOT EXISTS …`. That worked on SurrealDB v2, where the
-- clause was applied to the already-existing table (see the 0002 header
-- comment). On SurrealDB 3.x, `DEFINE TABLE IF NOT EXISTS` on a table that
-- already exists (all three are created by 0001) is a FULL no-op — the
-- CHANGEFEED clause is silently dropped (verified against the v3.2.4
-- testcontainer; see test/changefeed-drain.e2e-spec.ts, which had to
-- re-apply the attribute manually before this migration existed). The
-- result: any tenant database FIRST created under 3.x has no changefeed on
-- the audit-consumed tables, and the audit drain
-- (src/audit/changefeed-drain.service.ts, SOURCES = exactly these three
-- tables) has nothing to read. Tenants migrated under v2.x carry the feed
-- and are unaffected by the bug.
--
-- WHAT: `DEFINE TABLE OVERWRITE` re-declares the table-level attributes,
-- CHANGEFEED included. Field definitions, indexes, and data are separate
-- resources and persist untouched (verified in
-- test/changefeed-migration.e2e-spec.ts, which also pins that RE-applying
-- the identical definition preserves existing changefeed history — so
-- 2.x-migrated tenants that already carry a live feed lose neither history
-- nor drain cursors when this migration runs). knowledge_artifact (0004)
-- needs no fix: it is FIRST defined with its CHANGEFEED clause, so the
-- clause applies on creation even under 3.x.
--
-- ALTERNATIVES REJECTED:
--   * Re-running 0002 — same IF NOT EXISTS no-op, changes nothing.
--   * A narrow "alter changefeed" form — SurrealDB has no
--     ALTER TABLE … SET CHANGEFEED; OVERWRITE is the supported way to
--     change table-level attributes in place.
--
-- The table-level statements below mirror 0002 (and 0001 for the RELATION
-- clause) EXACTLY, with only IF NOT EXISTS → OVERWRITE. If a later
-- migration ever adds table-level attributes (PERMISSIONS, TYPE changes),
-- it must be reflected here or supersede this file. As of 0105 the only
-- table-level attributes on these tables are the ones below (0005's PII
-- permissions are FIELD-level and unaffected by a table re-define).
--
-- REMOVAL: safe to drop only after every tenant database has had this
-- migration applied once (the ledger guarantees that) — the definition is
-- then durable in each DB's schema.

DEFINE TABLE OVERWRITE knowledge_entity SCHEMAFULL CHANGEFEED 30d INCLUDE ORIGINAL;

DEFINE TABLE OVERWRITE knowledge_fact SCHEMAFULL CHANGEFEED 30d INCLUDE ORIGINAL;

DEFINE TABLE OVERWRITE knowledge_edge SCHEMAFULL TYPE RELATION
  IN knowledge_entity OUT knowledge_entity
  CHANGEFEED 30d INCLUDE ORIGINAL;
