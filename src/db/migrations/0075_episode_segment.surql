-- 0075: episode_segment — topical L0 segments as first-class retrieval units
-- (memory-rebuild R1, docs/roadmap/memory-rebuild-2026-07.md §2).
--
-- Verbatim multi-turn windows over the immutable episode substrate. Derived
-- state (rebuildable from episode at any time — delete-by-conversation then
-- reinsert), so deliberately NO changefeed. Segments carry their own dense
-- embedding AND a BM25 index: the read path retrieves them in parallel with
-- derived propositions and lets a joint rerank arbitrate, per the measured
-- evidence that raw text must be independently retrievable (union retrieval),
-- not merely quotable via provenance of selected facts.

DEFINE TABLE IF NOT EXISTS episode_segment SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS conversationId ON episode_segment TYPE string;
-- Window start index within the conversation's time-ordered episode list —
-- with the conversation id this makes re-segmentation idempotent.
DEFINE FIELD IF NOT EXISTS seq ON episode_segment TYPE int;
DEFINE FIELD IF NOT EXISTS episodeIds ON episode_segment TYPE array<record<episode>>;
-- Rendered verbatim text: one "[YYYY-MM-DD] Speaker: text" line per turn.
DEFINE FIELD IF NOT EXISTS text ON episode_segment TYPE string;
DEFINE FIELD IF NOT EXISTS occurredAt ON episode_segment TYPE datetime;
-- Union of the member turns' piiClass tags — the lane's PII gate reads this.
DEFINE FIELD IF NOT EXISTS piiClass ON episode_segment TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS userId ON episode_segment TYPE option<string>;
DEFINE FIELD IF NOT EXISTS embedding ON episode_segment TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS recorder ON episode_segment TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON episode_segment TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS segment_conv_seq_idx ON episode_segment
  FIELDS conversationId, seq UNIQUE;
DEFINE INDEX IF NOT EXISTS segment_conv_idx ON episode_segment FIELDS conversationId;

-- Same lowercase-only analyzer contract as episode_text (0073): snowball
-- stemming would mangle non-Latin scripts, and verbatim dialogue is
-- multilingual by nature.
DEFINE ANALYZER IF NOT EXISTS segment_text TOKENIZERS class FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS segment_text_search ON episode_segment
  FIELDS text FULLTEXT ANALYZER segment_text BM25;
