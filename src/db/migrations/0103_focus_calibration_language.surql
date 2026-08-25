-- 0103: hierarchical per-language focus calibration (multilingual Tier 5).
-- Companion to docs/roadmap/fovea-optics-2026-08.md §4.2 and
-- docs/roadmap/multilingual-2026-08.md.
--
-- WHY a language/script dimension. The §4.2 per-class isotonic calibrator
-- (0094/0095) keys the raw→P(correct) map by queryClass (routed LaneId) and
-- stage. The genre law that motivated per-class calibration has a
-- multilingual analogue: the raw focus confidence is systematically
-- mis-scaled across languages/scripts (a retrieval "coverage" that reads as
-- 0.7 on a Latin query does not mean the same P(correct) on a Cyrillic /
-- CJK one). Tier 5 adds a LANGUAGE key with a HIERARCHICAL fallback —
-- exact (class × language) → (class × script/family) → (class) global —
-- so a well-sampled language gets its own calibrator while a sparse one
-- falls back up the ladder (min-sample floor in fitPerClass) and never gets
-- a noisy per-language map.
--
-- ADDITIVE + OPTIONAL by construction (the 0094/0095/0102 posture): two new
-- OPTIONAL columns on each of the two focus tables, no default, no
-- migrate-time data mutation. Every existing row keeps language = NONE and
-- script = NONE — i.e. the global-per-class population — so with
-- MULTILINGUAL_CALIBRATION off the fit / load / apply path is BYTE-IDENTICAL
-- to pre-0103 (the readers add `AND language IS NONE AND script IS NONE`
-- when the flag is off, matching exactly these NONE rows). Every statement
-- is IF NOT EXISTS / REMOVE-then-DEFINE, so the migration is OVERWRITE-safe
-- and re-runnable.

-- ── focus_signal_sample: the query language/script the sample was captured
--    under (detected from the query at capture time, only when the Tier 5
--    flag is on). NONE ⇒ the sample belongs to the global per-class pool. ──
DEFINE FIELD IF NOT EXISTS language ON focus_signal_sample TYPE option<string>;
DEFINE FIELD IF NOT EXISTS script   ON focus_signal_sample TYPE option<string>;

-- ── focus_calibration: the language/script the fitted map calibrates. A
--    (class × language) row carries language set + script NONE; a
--    (class × script) row carries script set + language NONE; the global
--    per-class row carries both NONE (byte-identical to pre-0103). ──
DEFINE FIELD IF NOT EXISTS language ON focus_calibration TYPE option<string>;
DEFINE FIELD IF NOT EXISTS script   ON focus_calibration TYPE option<string>;

-- The version counter is now scoped per (queryClass, language, script,
-- stage): a (class × ru) map versions independently of the (class × Cyrl)
-- map and of the global (class) map. Extend the key index to carry both new
-- dimensions so the max-version-per-key read stays index-served.
-- (Non-unique — the reader picks max(version) per key.)
REMOVE INDEX IF EXISTS focus_calibration_key_idx ON focus_calibration;
DEFINE INDEX IF NOT EXISTS focus_calibration_key_idx ON focus_calibration
    FIELDS queryClass, language, script, stage, version;
