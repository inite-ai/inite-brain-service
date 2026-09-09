-- 0133: tenant_registry — WHEN the index state was observed, and on WHICH
-- indexes.
--
-- 0104 reserved `indexState` / `embeddingSpace` for a provisioning path that
-- did not exist; the HNSW provisioner (#512) now writes them. Two columns
-- were still missing, both about trusting the other two:
--
--   * indexStateAt — `updatedAt` is bumped by every touch()/register(), so
--     it cannot say when the INDEX was last looked at. Without its own
--     timestamp, `indexState = 'ready'` is unfalsifiable; the roster must be
--     able to admit its own age.
--   * indexDetail — `indexState` is a fold over several indexes and
--     'partial' is a real state (concurrent builds finish per index); the
--     operator's next action depends on WHICH one is missing.
--
-- `tenant_registry` lives in the SYSTEM database (0104), read and written
-- only through SurrealService.withAdminDb(); the migrator applies every file
-- to every database, so tenant-side copies of these fields exist unused.
-- Additive: two option<> fields, IF NOT EXISTS, no row touched, no index.
-- Existing rows read NONE for both — nothing has observed their indexes yet.
-- Operational metadata keyed by companyId: no personal data, no GDPR reach.

-- When indexState / indexDetail were last observed. NONE until the first
-- observation — never defaulted to time::now(), because a default would
-- make an unobserved tenant look freshly checked.
DEFINE FIELD IF NOT EXISTS indexStateAt ON tenant_registry TYPE option<datetime>;

-- Per-index fold behind `indexState`, as a compact, stable-ordered
-- `name=state` list, e.g.
--   "fact_embedding_hnsw=ready,fact_alt_embedding_hnsw=building,
--    entity_embedding_hnsw=absent,segment_embedding_hnsw=ready"
-- A string rather than an object: the shape is a fixed, code-owned list of
-- four names that is only ever read by a human or grepped, and SCHEMAFULL
-- object fields would need FLEXIBLE (which turns off the checking that is
-- the reason this table is SCHEMAFULL).
DEFINE FIELD IF NOT EXISTS indexDetail ON tenant_registry TYPE option<string>;
