-- 0086: conversation_digest — rolling per-conversation digest (V12 §2,
-- the graphiti saga port; LIGHT ablation: the scratchpad is the
-- load-bearing component at 100K, +160% on summarization).
--
-- One bounded narrative summary per (conversationId, derivedVersion),
-- built by the window deriver folding sessions chronologically into the
-- running state (durable facts only, newer wins on conflict, unchanged
-- when nothing new — the merge contract lives in the deriver prompt).
-- Derived state: rebuildable from episodes at any time, deliberately NO
-- changefeed, deleted-with-conversation on targeted re-derive.
--
-- Two watermarks (the graphiti design, verbatim rationale):
--   lastIngestAt — INGESTION-time filter watermark: the next incremental
--     fold picks up episodes with createdAt > lastIngestAt. Ingestion
--     time because it is monotonic — a backfilled episode with an old
--     occurredAt still gets folded; an event-time filter would silently
--     drop it.
--   lastEventAt — EVENT-time semantic watermark: max(occurredAt) over
--     folded episodes, advanced only forward. Answers "how current is
--     this digest in event time?" for consumers.

DEFINE TABLE IF NOT EXISTS conversation_digest SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS conversationId ON conversation_digest TYPE string;
-- The derived world this digest belongs to; NONE = the legacy namespace.
DEFINE FIELD IF NOT EXISTS derivedVersion ON conversation_digest TYPE option<string>;
DEFINE FIELD IF NOT EXISTS summary ON conversation_digest TYPE string;
DEFINE FIELD IF NOT EXISTS lastIngestAt ON conversation_digest TYPE datetime;
DEFINE FIELD IF NOT EXISTS lastEventAt ON conversation_digest TYPE datetime;
DEFINE FIELD IF NOT EXISTS updatedAt ON conversation_digest TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS digest_conv_version_idx ON conversation_digest
  FIELDS conversationId, derivedVersion UNIQUE;
