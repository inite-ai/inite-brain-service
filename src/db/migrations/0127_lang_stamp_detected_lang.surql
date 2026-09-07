-- 0127: write-side language-stamp confidence gate — the withheld label.
--
-- WHY. MULTILINGUAL_LANG_STAMP_CONFIDENCE_GATE (the write-side mirror of
-- the 0126-era read fix for the code-memory k07 miss) withholds the
-- authoritative `lang` column when the detector's confidence sits below
-- the shared high-confidence floor — the "120 requests per minute" →
-- it@0.33 mislabel stops polluting rows that every future lang-aware
-- consumer inherits. Withholding must never be silent: the attribution
-- stamp (0100) keeps the confidence + detector version, and THIS column
-- keeps the label itself, so the row still says exactly what the
-- detector claimed while `lang` stays NONE (= never hard-filtered).
--
-- ADDITIVE + OPTIONAL by construction (the 0100 posture): option<...>,
-- no backfill, nothing writes it unless the gate withholds a detection.
-- Gate off (default) ⇒ the column is never written — byte-identical.

-- The below-floor detected label the stamp gate kept out of `lang`.
-- NONE on every ungated row (an ungated detection lives in `lang`
-- itself; duplicating it here would change the gate-off stamp).
DEFINE FIELD IF NOT EXISTS detectedLang ON knowledge_fact TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 2;
