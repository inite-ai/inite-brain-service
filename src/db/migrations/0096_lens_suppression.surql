-- 0096: fovea optics (Optics §4.3) — the lens-suppression governor's
-- per-(company, class) suppression model. Companion to
-- docs/roadmap/fovea-optics-2026-08.md §4.3 and the trap-resistance
-- shakedown docs/roadmap/memtrap-shakedown-2026-08.md.
--
-- WHAT this stores. The governor is SUBTRACTIVE: for a query's learned
-- class it REMOVES off-task / trap-inducing lanes from the effective
-- active set (never adds, never reorders). A row is one learned class:
--   centroid      — the class's query-embedding centroid (nearest-centroid
--                   match, Semantic Router pattern; cosine ≥ a floor knob).
--   suppressLanes — the LaneIds this class hard-suppresses (the genre-toxic
--                   combinations; the shakedown's trap carriers are the
--                   instruction + strategy lanes).
--   sampleCount   — labeled samples behind the class. A "usable model" needs
--                   at least one class with sampleCount > 0 (mirrors
--                   focus-signal's hasUsableCalibration); an empty/bootstrap
--                   model falls back to today's static routing.
--
-- SERVING-NEUTRAL WITHOUT A MODEL: this table is READ on the serving path
-- ONLY behind FOVEA_LENS_SUPPRESS (default off) AND only when a usable
-- model is persisted. Flag off, no model, or a low-confidence class match
-- → the effective profile is the ORIGINAL lane set, byte-identical.
--
-- The training data is OFFLINE ablation-mined and PARKED, so the admin
-- `fit` is a THIN INGEST of externally-provided (class, centroid,
-- suppressLanes) rows rather than a serving-time learner. Persistence
-- mirrors the focus_calibration versioning idiom (0094/0095): one
-- versioned row per class, the reader picks max(version) per class.

DEFINE TABLE IF NOT EXISTS lens_suppression SCHEMAFULL;

-- Owning tenant (rows are also physically scoped to the per-company DB via
-- withCompany; the column is kept for cross-tenant aggregation later).
DEFINE FIELD IF NOT EXISTS companyId ON lens_suppression TYPE string;
-- The learned class key (the fovea query-class analogue — a routed LaneId,
-- an ablation-mined cluster label, or 'default'). Free string.
DEFINE FIELD IF NOT EXISTS classId ON lens_suppression TYPE string;
-- The class's query-embedding centroid (nearest-centroid match).
DEFINE FIELD IF NOT EXISTS centroid ON lens_suppression TYPE array<float>;
-- The LaneIds this class hard-suppresses (validated against the LaneId
-- union at read time — unknown ids are dropped, never a routing add).
DEFINE FIELD IF NOT EXISTS suppressLanes ON lens_suppression TYPE array<string>;
-- Labeled samples behind this class; usability gate = some class > 0.
DEFINE FIELD IF NOT EXISTS sampleCount ON lens_suppression TYPE int DEFAULT 0;
-- Monotone version counter; the reader picks max(version) per class.
DEFINE FIELD IF NOT EXISTS version ON lens_suppression TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS createdAt ON lens_suppression TYPE datetime
    DEFAULT time::now();

-- The max-version-per-class read is index-served. (Non-unique — the
-- reader orders by version DESC and takes the first row per class.)
DEFINE INDEX IF NOT EXISTS lens_suppression_key_idx ON lens_suppression
    FIELDS classId, version;
