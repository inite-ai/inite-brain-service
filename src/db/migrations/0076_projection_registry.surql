-- 0076_projection_registry — raw-substrate driver v1, surface 3
-- (docs/roadmap/raw-substrate-driver-2026-08.md).
--
-- First-class records for each derived surface (facts@wd-v2, segments@v,
-- communities@v, …): status, watermark, builder identity. The derived
-- worlds themselves already exist (knowledge_fact.derivedVersion + the
-- RETRIEVAL_DERIVED_VERSION pin flip); this table makes their lifecycle
-- observable and addressable — POST /v1/projections/:name/rebuild becomes
-- the public verb over the maintenance batch engine.
--
-- Status vocabulary:
--   building — builder is writing this version now
--   built    — complete, not the live read pin
--   live     — complete and marked as the active read version
--   residual — superseded by a later live version; world still queryable
--   failed   — builder aborted; world may be partial (rebuild overwrites)
-- Reaped worlds (derive/gc) get their registry rows DELETED — a row
-- promises a queryable world.
--
-- Record id = projection:[name, version] (array-literal id, verified
-- idempotent under UPSERT on 3.1.5) — identity lives in the id, no
-- UNIQUE index needed.

DEFINE TABLE IF NOT EXISTS projection SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS name ON projection TYPE string;
DEFINE FIELD IF NOT EXISTS version ON projection TYPE string;
DEFINE FIELD IF NOT EXISTS status ON projection TYPE string
  ASSERT $value INSIDE ['building', 'built', 'live', 'residual', 'failed'];
DEFINE FIELD IF NOT EXISTS builder ON projection TYPE string;
DEFINE FIELD IF NOT EXISTS watermark ON projection TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS startedAt ON projection TYPE datetime;
DEFINE FIELD IF NOT EXISTS finishedAt ON projection TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS stats ON projection FLEXIBLE TYPE option<object>;
