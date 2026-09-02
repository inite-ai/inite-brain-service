-- 0124: fragment-content lexical search — the BM25 leg of the fragment
-- retrieval lane (Evidence Plane M-track, MM-zoom PR2).
--
-- WHY. The 0109 substrate gave non-text observations durable identity
-- (evidence_asset / evidence_fragment) and recomputable text
-- interpretations (derived_representation.content: captions, OCR, ASR,
-- text renders) — but no retrieval surface: content had no FULLTEXT
-- index, so the synthesize-side fragment lane could not run a lexical
-- leg. This migration adds exactly that index. The dense leg needs no
-- migration — derived_representation.embedding exists since 0109
-- (write-dead in v1) and the lane's dense read is a brute cosine scan
-- that degrades to empty until a producer fills the column.
--
-- Same lowercase-only analyzer contract as episode_text (0073) /
-- segment_text (0075) / scene_gist (0106): snowball stemming would
-- mangle non-Latin scripts, and caption/OCR/ASR text is multilingual by
-- nature.
--
-- SINGLE-FIELD only, deliberately (the 0109 rationale carries over): on
-- SurrealDB 3.2.4 a DELETE planned through a COMPOUND index can
-- silently no-op, and derived_representation sits on two delete paths
-- (GDPR cascade + producer-version re-runs). No new fields, no
-- changefeed, no event — 0109's GDPR reasoning stands.
--
-- NUMBERING: 0119-0123 are reserved by in-flight sibling PRs of the
-- MM-zoom wave; this file deliberately takes 0124 — the migrator orders
-- by filename and tolerates gaps (the 0109/0112 precedent); do NOT
-- renumber on rebase.

DEFINE ANALYZER IF NOT EXISTS fragment_content TOKENIZERS class FILTERS lowercase;
DEFINE INDEX IF NOT EXISTS derived_repr_content_search ON derived_representation
  FIELDS content FULLTEXT ANALYZER fragment_content BM25;
