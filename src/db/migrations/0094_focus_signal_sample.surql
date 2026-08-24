-- 0094: fovea optics (Optics-1 foundation) — focus-signal capture +
-- per-class calibration storage. Companion to
-- docs/roadmap/fovea-optics-2026-08.md §3, §4.2.
--
-- SERVING-NEUTRAL: these tables are WRITTEN behind FOVEA_FOCUS_CAPTURE
-- (default off) and READ only by the admin fit/measure surface. Nothing
-- on the serving path consumes them yet (Optics-2/3 will wire depth /
-- threshold / lens-suppression). The schema exists so the §3
-- measurement (ECE / reliability diagram) can run once samples exist.
--
-- Two tables:
--   focus_signal_sample — one row per captured (signal, outcome) sample.
--     `correct` is option<int> (NONE until the eval harness backfills the
--     label — the synthesize DTO carries no expected answer, so
--     correctness is unknowable at serving time).
--   focus_calibration — the fitted per-query-class isotonic maps
--     (fitPerClass output), one versioned row per class. Mirrors the
--     calibration_table (0019) row shape — thresholds/values arrays — so
--     it reuses the same PAV serialization idiom.

DEFINE TABLE IF NOT EXISTS focus_signal_sample SCHEMAFULL;

-- Owning tenant (rows are also physically scoped to the per-company DB via
-- withCompany; the column is kept for cross-tenant fit aggregation later).
DEFINE FIELD IF NOT EXISTS companyId ON focus_signal_sample TYPE string;
-- Opaque application-generated key. The eval harness discovers it via the
-- list endpoint and backfills `correct` by it — no RecordId round-tripping.
DEFINE FIELD IF NOT EXISTS sampleId ON focus_signal_sample TYPE string;
-- Calibration class = routed LaneId, or 'default' for unrouted queries.
DEFINE FIELD IF NOT EXISTS queryClass ON focus_signal_sample TYPE string;
-- The signal inputs (all in [0,1]) — see FocusSignal in focus-signal.ts.
DEFINE FIELD IF NOT EXISTS topScore ON focus_signal_sample TYPE float;
DEFINE FIELD IF NOT EXISTS coverageScore ON focus_signal_sample TYPE float;
DEFINE FIELD IF NOT EXISTS verifierVerdict ON focus_signal_sample TYPE string;
DEFINE FIELD IF NOT EXISTS retrievalGap ON focus_signal_sample TYPE float;
-- The raw blended confidence at capture time (rawFocusConfidence) — stored
-- so a later refit need not recompute it and so drift in the blend is
-- auditable against historical samples.
DEFINE FIELD IF NOT EXISTS rawConfidence ON focus_signal_sample TYPE float;
-- Observed outcome: 1 correct, 0 incorrect. NONE until labeled.
DEFINE FIELD IF NOT EXISTS correct ON focus_signal_sample TYPE option<int>;
DEFINE FIELD IF NOT EXISTS createdAt ON focus_signal_sample TYPE datetime
    DEFAULT time::now();

-- Fit reads samples by class (and filters to labeled rows); the measure
-- surface pages recent samples.
DEFINE INDEX IF NOT EXISTS focus_sample_class_idx ON focus_signal_sample
    FIELDS queryClass;
DEFINE INDEX IF NOT EXISTS focus_sample_created_idx ON focus_signal_sample
    FIELDS createdAt;
DEFINE INDEX IF NOT EXISTS focus_sample_id_idx ON focus_signal_sample
    FIELDS sampleId UNIQUE;

DEFINE TABLE IF NOT EXISTS focus_calibration SCHEMAFULL;

-- The query-class this map calibrates ('default' = shared/fallback map).
DEFINE FIELD IF NOT EXISTS queryClass ON focus_calibration TYPE string;
-- The fitted PAV map (same encoding as calibration_table): thresholds[i]
-- is the upper bound of bin i, values[i] the calibrated value emitted when
-- raw <= thresholds[i].
DEFINE FIELD IF NOT EXISTS thresholds ON focus_calibration TYPE array<float>;
DEFINE FIELD IF NOT EXISTS values     ON focus_calibration TYPE array<float>;
-- Diagnostic — labeled pairs that fitted this row.
DEFINE FIELD IF NOT EXISTS sampleCount ON focus_calibration TYPE int DEFAULT 0;
-- Monotone version counter; the reader picks max(version) per class.
DEFINE FIELD IF NOT EXISTS version ON focus_calibration TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS createdAt ON focus_calibration TYPE datetime
    DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS focus_calibration_key_idx ON focus_calibration
    FIELDS queryClass, version;
