-- 0012_predicate_embedding — embedding field for EDC canonicalisation.
--
-- Adds an embedding column to the predicate registry so the runtime can
-- run similarity search against the active predicate set. This is the
-- substrate for EDC (Extract-Define-Canonicalise, arXiv:2404.03868):
-- when the extractor encounters a never-before-seen predicate, the
-- system embeds the (predicateId + description + sample valueSpan) text
-- and looks for an existing predicate within cosine ≥ 0.85. Above the
-- threshold the novel predicate is aliased to the canonical id; below,
-- it's inserted as status='proposed' for human/agent review.
--
-- HNSW is commented out intentionally (mirrors the same pattern on
-- knowledge_fact / knowledge_entity in 0001) — the registry is small
-- (single digits to low hundreds of predicates per tenant), brute-force
-- cosine over an array<float> is fast enough and avoids the operator
-- ceremony of enabling HNSW. If a tenant ever grows past ~10k
-- predicates the index becomes warranted.

DEFINE FIELD IF NOT EXISTS embedding ON knowledge_predicate
  TYPE option<array<float>>;

-- Optional HNSW for very large registries — leave commented until needed.
-- DEFINE INDEX IF NOT EXISTS predicate_embedding_idx ON knowledge_predicate
--   FIELDS embedding HNSW DIMENSION 1536 DIST COSINE EFC 200 M 16;
