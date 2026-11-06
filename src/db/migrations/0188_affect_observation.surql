-- 0188_affect_observation — how a person seemed to feel, read from their
-- own words, as observations at a time (#909 step 4).
--
-- WHY A TABLE OF ITS OWN. The relationship layer's doctrine (§2.3) is
-- "affect as observation, never as trait": an inference is a signal at T
-- with its source and confidence, never the person's current state. The
-- belief plane holds one active value per (user, subject, field) behind a
-- supersede chain — the opposite shape: signals accumulate, and a later
-- one never replaces an earlier one. So observations are append-only rows
-- here, each citing the turn and the exact words it was read from.
--
-- WHAT A ROW IS. One emotionally loaded span of one of the person's own
-- turns: valence in −1..1 (text carries valence; arousal it does not —
-- LLM arousal judgements track human ratings at r≈0.2–0.3), a coarse
-- label (Ekman's six or neutral, the GoEmotions mapping), what it was
-- about (the appraisal target), a calibrated confidence, the reader and
-- model that read it. Class `affect` by construction: every read surface
-- needs brain:read_pii, and export / erase / contest / forget cover it.
--
-- affect_reading marks a turn as read by a reader version, observation or
-- not (most turns are neutral and yield none) — the reader's cursor.
--
-- Retention: rows older than the consenting pack's
-- affectInference.retentionDays are deleted by the reader's sweep.
-- Idempotent: IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS affect_observation SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON affect_observation TYPE string;
DEFINE FIELD IF NOT EXISTS episodeId ON affect_observation TYPE record<episode>;
DEFINE FIELD IF NOT EXISTS conversationId ON affect_observation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS observedAt ON affect_observation TYPE datetime;
DEFINE FIELD IF NOT EXISTS valence ON affect_observation TYPE float
  ASSERT $value >= -1 AND $value <= 1;
DEFINE FIELD IF NOT EXISTS label ON affect_observation TYPE string
  ASSERT $value IN ['anger', 'disgust', 'fear', 'joy', 'sadness', 'surprise', 'neutral'];
DEFINE FIELD IF NOT EXISTS target ON affect_observation TYPE option<string>;
-- The exact words, and where they sit in the stored turn (code points).
DEFINE FIELD IF NOT EXISTS quote ON affect_observation TYPE string;
DEFINE FIELD IF NOT EXISTS spanStart ON affect_observation TYPE int;
DEFINE FIELD IF NOT EXISTS spanEnd ON affect_observation TYPE int;
DEFINE FIELD IF NOT EXISTS confidence ON affect_observation TYPE float
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD IF NOT EXISTS modality ON affect_observation TYPE string DEFAULT 'text'
  ASSERT $value IN ['text'];
DEFINE FIELD IF NOT EXISTS readerVersion ON affect_observation TYPE string;
DEFINE FIELD IF NOT EXISTS model ON affect_observation TYPE option<string>;
DEFINE FIELD IF NOT EXISTS piiClass ON affect_observation TYPE string DEFAULT 'affect'
  ASSERT $value = 'affect';
DEFINE FIELD IF NOT EXISTS createdAt ON affect_observation TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS affect_obs_user_idx ON affect_observation FIELDS userId;
DEFINE INDEX IF NOT EXISTS affect_obs_observed_idx ON affect_observation FIELDS observedAt;

DEFINE TABLE IF NOT EXISTS affect_reading SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON affect_reading TYPE string;
DEFINE FIELD IF NOT EXISTS episodeId ON affect_reading TYPE record<episode>;
DEFINE FIELD IF NOT EXISTS readerVersion ON affect_reading TYPE string;
DEFINE FIELD IF NOT EXISTS observations ON affect_reading TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS readAt ON affect_reading TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS affect_reading_user_idx ON affect_reading FIELDS userId;
DEFINE INDEX IF NOT EXISTS affect_reading_uq ON affect_reading FIELDS episodeId, readerVersion UNIQUE;
