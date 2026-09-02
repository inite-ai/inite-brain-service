-- 0121: evidence processing lifecycle — idempotent processing runs,
-- derived-representation lineage, and the quarantine safety seam
-- (Brain v2.1 MM-1/MM-5/MM-6).
--
-- WHY. The evidence substrate (0109) stores observations and their
-- recomputable interpretations, but nothing records WHO computed an
-- interpretation, WITH WHAT configuration, or WHETHER it already ran.
-- Without that, a platform-executed processor (caption/ocr/asr/text
-- extraction) cannot be replayed safely: a retried dispatch would write
-- duplicate representations, and a re-run under a new processor version
-- could not supersede its predecessor's output deterministically.
--   * processing_run          — one row per (asset, capability,
--     processorVersion, configFingerprint): the idempotency ledger for
--     platform-executed processors. The row id is DETERMINISTIC (a hash
--     of the key, the 0105 audit_event / #92 idiom) so a replayed
--     dispatch collides on the primary key via INSERT IGNORE and no-ops
--     instead of double-processing.
--   * derived_representation  — gains lineage (producedByRun) and the
--     supersede pointer (supersededBy, the 0059 knowledge_fact
--     .supersededBy precedent: the OLD row points at its replacement) —
--     re-processing never mutates or deletes; GC owns removal.
--   * evidence_asset          — gains quarantineStatus, the external-
--     ingest safety seam: bytes that did not originate inside the
--     platform sit 'quarantined' until a scan passes; the processor
--     broker refuses to touch non-clean assets.
--
-- ALTERNATIVES CONSIDERED.
--   * A UNIQUE compound index as the run idempotency key: rejected —
--     compound indexes on SurrealDB 3.2.4 put the table's delete path
--     into the compound-planner DELETE no-op class (this table is on the
--     GDPR cascade), and the deterministic-record-id + INSERT IGNORE
--     idiom (0105) achieves the same collision semantics on the primary
--     key alone.
--   * Deleting old representations on re-process: rejected — the
--     supersededBy pointer keeps the old row readable until the sweeper
--     collects it, so an in-flight reader never sees its citation target
--     vanish mid-answer; deletion stays owned by the GC/retention legs.
--   * A DEFAULT on quarantineStatus: rejected on purpose — with
--     EVIDENCE_QUARANTINE off the write seam must produce byte-identical
--     rows, and a DEFAULT would stamp every new row. Absent = legacy /
--     off-era row, read as clean (all pre-seam writes were internal).
--   * Widening the evidence_blob_gc.reason enum (0114) for quarantine
--     rejection: rejected — rejection reuses the RETENTION tombstone
--     path (availability='gone'; a failed blob delete keeps storageRef so
--     reconcileGoneBlobs retries), so the outbox enum stays untouched.
--
-- NO CHANGEFEED / DEFINE EVENT, deliberately (same GDPR reasoning as
-- 0109/0073/0106/0107): run rows can carry error text derived from
-- personal observations, and representation lineage must not keep
-- GDPR-erased content discoverable in a feed after the rows die.
--
-- ALL indexes single-field, deliberately: on SurrealDB 3.2.4 a DELETE
-- whose WHERE is planned through a COMPOUND index can silently no-op,
-- and processing_run sits on the GDPR + retention delete paths.
--
-- RENUMBER CAVEAT: 0119/0120 are reserved by sibling in-flight PRs. The
-- migrator orders by filename and tolerates gaps (0109 doctrine) — 0121
-- stays 0121 either way; do NOT renumber on rebase.

-- ── processing_run ────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS processing_run SCHEMAFULL;

-- Typed link: the GDPR user-forget cascade traverses assetId.
DEFINE FIELD IF NOT EXISTS assetId ON processing_run TYPE record<evidence_asset>;
-- v1 dispatches at asset granularity; fragment-level runs are future work.
DEFINE FIELD IF NOT EXISTS fragmentId ON processing_run TYPE option<record<evidence_fragment>>;
-- Capability = the representation kind produced (pinned to the TS taxonomy).
DEFINE FIELD IF NOT EXISTS capability ON processing_run TYPE string
  ASSERT $value INSIDE ['caption', 'ocr', 'asr', 'object_track', 'scene_graph', 'embedding', 'text'];
DEFINE FIELD IF NOT EXISTS processorVersion ON processing_run TYPE string;
-- 8-hex config fingerprint (#386 sceneConfigFingerprint idiom) — part of
-- the idempotency key: a config change is a NEW run, never an overwrite.
DEFINE FIELD IF NOT EXISTS configFingerprint ON processing_run TYPE string;
-- Requesting pack (attribution only — the pack NEVER executes anything).
DEFINE FIELD IF NOT EXISTS packId ON processing_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON processing_run TYPE string
  ASSERT $value INSIDE ['pending', 'running', 'succeeded', 'failed', 'superseded'];
DEFINE FIELD IF NOT EXISTS startedAt ON processing_run TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS finishedAt ON processing_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS attempts ON processing_run TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS outputs ON processing_run TYPE option<array<record<derived_representation>>>;
-- Code-capped (500 chars) + redacted before write — error text can quote
-- content derived from personal observations.
DEFINE FIELD IF NOT EXISTS error ON processing_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON processing_run TYPE datetime DEFAULT time::now();

-- Single-field only (3.2.4 planner discipline; GDPR delete path).
DEFINE INDEX IF NOT EXISTS processing_run_asset_idx ON processing_run FIELDS assetId;
DEFINE INDEX IF NOT EXISTS processing_run_status_idx ON processing_run FIELDS status;
DEFINE INDEX IF NOT EXISTS processing_run_started_idx ON processing_run FIELDS startedAt;

-- ── derived_representation lineage (additive; 0109 shape untouched) ───

DEFINE FIELD IF NOT EXISTS producedByRun ON derived_representation TYPE option<record<processing_run>>;
-- 0059 knowledge_fact.supersededBy precedent: old row points at its
-- replacement; readers filter on `supersededBy IS NONE` for the current
-- generation, and the sweeper collects pointed-at rows later.
DEFINE FIELD IF NOT EXISTS supersededBy ON derived_representation TYPE option<record<derived_representation>>;
DEFINE INDEX IF NOT EXISTS derived_repr_run_idx ON derived_representation FIELDS producedByRun;
DEFINE INDEX IF NOT EXISTS derived_repr_superseded_idx ON derived_representation FIELDS supersededBy;

-- ── evidence_asset quarantine (additive; option WITHOUT DEFAULT) ──────

-- No DEFAULT on purpose: with EVIDENCE_QUARANTINE off the write seam must
-- produce byte-identical rows (a DEFAULT would stamp every new row).
-- Absent = legacy/off-era row, read as clean (all pre-seam writes were
-- internal — no external ingest surface exists before this seam).
DEFINE FIELD IF NOT EXISTS quarantineStatus ON evidence_asset TYPE option<string>
  ASSERT $value IS NONE OR $value INSIDE ['quarantined', 'scanning', 'clean', 'rejected'];
DEFINE INDEX IF NOT EXISTS evidence_asset_quarantine_idx ON evidence_asset FIELDS quarantineStatus;
