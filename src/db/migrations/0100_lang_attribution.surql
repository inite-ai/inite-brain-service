-- 0100: confidence-aware language attribution (multilingual Tier 1).
--
-- WHY. Phase-4 tagged each fact with a single `lang` (the stored
-- `object`'s language = contentLang) and NOTHING else — no confidence,
-- no record of HOW the label was chosen, and the short-string path
-- silently defaulted to `en` (scoreLatinLanguage's zero-stopword-hit
-- fallback). That default is a systematic mislabel for numeric / short /
-- code-switched objects. Tier 1 makes attribution confidence-aware: the
-- detector returns `und` (not `en`) for stopword-less input under
-- MULTILINGUAL_LANG_ATTRIBUTION, and the resolver records the confidence,
-- the SOURCE of the label, the detector version, and — distinct from the
-- object's own language — the language of the SOURCE message/turn.
--
-- ADDITIVE + OPTIONAL by construction (the 0098/0099 posture): every
-- column is option<...>, so existing rows are unaffected and NO backfill
-- is needed. A write that omits these fields stores nothing for them.
-- The attribution write path is gated OFF by MULTILINGUAL_LANG_ATTRIBUTION
-- at the service layer — master off ⇒ these columns are never written and
-- never read, so serving is byte-identical to pre-0100. `lang` is kept
-- AS-IS (still contentLang); these columns sit beside it.
--
-- No migration-time data mutation: existing rows are re-stamped only by
-- the explicit, flag-gated admin backfill (scripts/backfill-lang-attribution),
-- never at migrate time.

-- Detector confidence for `lang`, 0..1 (the numeric idiom is float — cf.
-- 0044 agreementRate, candidate.confidence). NONE on pre-0100 rows and on
-- any write made while attribution is off.
DEFINE FIELD IF NOT EXISTS langConfidence ON knowledge_fact TYPE option<float>
    ASSERT $value IS NONE OR ($value >= 0 AND $value <= 1);

-- HOW the `lang` label was chosen:
--   detected  — the detector read it off the object text
--   inherited — the object was too short/stopword-less to detect, so the
--               SOURCE message/turn language was inherited onto it
--   explicit  — the caller supplied a known language for the content
DEFINE FIELD IF NOT EXISTS langSource ON knowledge_fact TYPE option<string>
    ASSERT $value IS NONE OR $value IN ['detected', 'inherited', 'explicit'];

-- Version tag of the detector that produced the label — lets a re-fit /
-- backfill be attributed and lets telemetry slice by detector generation.
DEFINE FIELD IF NOT EXISTS detectorVersion ON knowledge_fact TYPE option<string>;

-- The language of the SOURCE message/turn the fact was extracted from,
-- DISTINCT from `lang` (the stored object's language = contentLang). A
-- Russian turn can yield a fact whose object is a short English proper
-- noun; sourceLang preserves the turn language while `lang` stays the
-- object's. NONE when the turn language is unknown.
DEFINE FIELD IF NOT EXISTS sourceLang ON knowledge_fact TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 2;

-- episode (0073) is the other table that stamps `lang` (episode-store
-- detects it off the raw turn text). Mirror the attribution columns here
-- for schema parity so a future episode-side backfill has somewhere to
-- land — sourceLang is omitted because an episode IS the source, so its
-- own `lang` already carries the source-turn language. Nothing writes
-- these yet (episode-side attribution stamping is a documented follow-up);
-- additive + optional, so this is a pure schema widening.
DEFINE FIELD IF NOT EXISTS langConfidence ON episode TYPE option<float>
    ASSERT $value IS NONE OR ($value >= 0 AND $value <= 1);
DEFINE FIELD IF NOT EXISTS langSource ON episode TYPE option<string>
    ASSERT $value IS NONE OR $value IN ['detected', 'inherited', 'explicit'];
DEFINE FIELD IF NOT EXISTS detectorVersion ON episode TYPE option<string>;
