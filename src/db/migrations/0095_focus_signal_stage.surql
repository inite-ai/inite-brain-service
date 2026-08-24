-- 0095: fovea optics (Optics §4.2) — stage discriminator on the
-- focus-signal sample + calibration rows. Companion to
-- docs/roadmap/fovea-optics-2026-08.md §4.2, §3.
--
-- WHY a stage column. The abstention gate (verdict.ts:coverageAbstention)
-- runs BEFORE generation and BEFORE the verifier, so at that point there
-- is NO verifier verdict — a pre-answer signal. Optics-1 captured samples
-- at the VERDICT point (a real verdict), and rawFocusConfidence weights the
-- verdict ~0.35, so applying a verdict-fit calibrator to a no-verdict
-- pre-answer signal would be systematically miscalibrated (the §3
-- "adaptive amplifies a bad signal" trap). fit-shape MUST equal apply-shape:
-- the two populations must never be pooled. `stage` keeps them apart —
--   'verdict'   — captured at the synthesize verdict point (Optics-1/2).
--   'preanswer' — captured at the coverage-abstention gate, verdict='none'
--                 (Optics §4.2). Because verdict is a CONSTANT 'none' across
--                 every pre-answer sample, its contribution is a constant
--                 offset the isotonic fit absorbs cleanly — no miscalibration.
--
-- BACKWARD COMPAT: stage is option<string> with NO default; a row whose
-- stage is NONE is READ AS 'verdict' (that is the only population that
-- existed before this migration). Existing rows are backfilled to 'verdict'
-- below; every new insert writes stage explicitly. The verdict-stage reader
-- therefore matches (stage = 'verdict' OR stage IS NONE), so Optics-2's
-- stage-less loadCalibration(companyId) call is byte-identical.

-- ── focus_signal_sample: add + backfill stage ──────────────────────────
DEFINE FIELD IF NOT EXISTS stage ON focus_signal_sample TYPE option<string>;
-- Existing samples predate the pre-answer population → they are verdict-point.
UPDATE focus_signal_sample SET stage = 'verdict' WHERE stage IS NONE;

-- ── focus_calibration: add + backfill stage ────────────────────────────
DEFINE FIELD IF NOT EXISTS stage ON focus_calibration TYPE option<string>;
-- Existing calibrators were fit from verdict-point samples.
UPDATE focus_calibration SET stage = 'verdict' WHERE stage IS NONE;

-- The version counter is now scoped per (queryClass, stage): a preanswer
-- 'default' map and a verdict 'default' map version independently. Extend
-- the key index to carry stage so the max-version-per-(class,stage) read is
-- index-served. (Non-unique — the reader picks max(version) per class.)
REMOVE INDEX IF EXISTS focus_calibration_key_idx ON focus_calibration;
DEFINE INDEX IF NOT EXISTS focus_calibration_key_idx ON focus_calibration
    FIELDS queryClass, stage, version;
