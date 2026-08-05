-- 0073_episode_substrate — L0 of the memory substrate redesign
-- (docs/roadmap/memory-substrate-redesign-2026-07.md, P1).
--
-- THE INVERSION THIS STARTS. Today extraction is the source of truth and the
-- raw dialogue turn is discarded after the LLM pass — every extractor mistake
-- is permanent, extractor improvements cannot be re-applied to history, and
-- GDPR forget chases derived facts it cannot enumerate. `episode` is the
-- immutable, lossless substrate those problems require: verbatim turns land
-- here BEFORE extraction, and everything derived can eventually point back
-- via the derivation registry (P3).
--
-- DESIGN NOTES.
--  * No stored seq / sessionId: order is (occurredAt, messageId) at read;
--    sessionization is a derivation-time concern (time-gap segmentation), not
--    a write-time one — removes the cross-pod counter race.
--  * UNIQUE (conversationId, messageId) makes ingest retries idempotent
--    (INSERT IGNORE in the write path).
--  * embedding is declared but NOT written at P1 — it is derived state,
--    backfillable from text; keeping the write path LLM- and embedder-free is
--    the point of the substrate.
--  * NO CHANGEFEED on this table, deliberately: a 30-day INCLUDE ORIGINAL
--    feed would keep forgotten verbatim text readable after a GDPR delete.
--    Derivation scheduling uses task watermarks, not a feed.
--  * Analyzer: lowercase-only tokenization. The shared `content` analyzer
--    (ascii + snowball(english)) mangles Cyrillic; verbatim dialogue must
--    stay searchable in any language. Per-language stemmed indexes are a
--    later optimization keyed on episode.lang.
--  * text is stored through the P0-fixed redactor (redactPiiWithReport);
--    piiClass records what was found so the episodic retrieval lane can be
--    scope-gated like predicate-classed facts are today.

DEFINE TABLE IF NOT EXISTS episode SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS kind ON episode TYPE string
  ASSERT $value INSIDE ['turn', 'event', 'observation'];
DEFINE FIELD IF NOT EXISTS conversationId ON episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS messageId ON episode TYPE string;
DEFINE FIELD IF NOT EXISTS speaker ON episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS addressee ON episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS text ON episode TYPE string;
DEFINE FIELD IF NOT EXISTS piiClass ON episode TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS occurredAt ON episode TYPE datetime;
DEFINE FIELD IF NOT EXISTS recordedAt ON episode TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS embedding ON episode TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS lang ON episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS userId ON episode TYPE option<string>;
DEFINE FIELD IF NOT EXISTS source ON episode TYPE object FLEXIBLE;

DEFINE INDEX IF NOT EXISTS episode_msg_uq ON episode
  FIELDS conversationId, messageId UNIQUE;
DEFINE INDEX IF NOT EXISTS episode_conv_idx ON episode
  FIELDS conversationId, occurredAt;

DEFINE ANALYZER IF NOT EXISTS episode_text
  TOKENIZERS class
  FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS episode_text_idx ON episode
  FIELDS text FULLTEXT ANALYZER episode_text BM25;
