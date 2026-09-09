-- 0139: retire the two HNSW indexes no query consumes, and the column one
-- of them rode.
--
-- Measured (2026-09-09): every `<|K,EF|>` in the application runs over
-- knowledge_fact.embedding (the fact legs, the dedup seed, inline entity
-- resolution) or episode_segment.embedding (the coverage-scan lane, and
-- from this change the segment legs and the segment lane).
--
--   * knowledge_fact.altEmbedding — the HyPE experiment's column. Its writer
--     was reverted; nothing reads it; it is empty on every deployment.
--     fact_alt_embedding_hnsw was built, waited for and counted in readiness
--     for a column that is never written. Both go.
--   * knowledge_entity.embedding — has no KNN and no cosine consumer (entity
--     resolution compares FACT vectors, not entity vectors), so
--     entity_embedding_hnsw was likewise dead weight. The column stays: it
--     is written by ingest and is part of the reindex sweep (a future
--     entity-vector consumer wants it), only the index goes.
--
-- REMOVE FIELD on a column that holds no vector touches no data; the truth
-- test (test/embedding-space-truth.unit-spec.ts) folds this removal into
-- the schema it derives from the migrations, so the column is no longer
-- expected in VECTOR_COLUMNS. HnswMaintenanceService's INDEX_SPECS drops
-- both indexes in the same change, so `create`/`ensure` never bring them
-- back.
REMOVE INDEX IF EXISTS fact_alt_embedding_hnsw ON knowledge_fact;
REMOVE INDEX IF EXISTS entity_embedding_hnsw ON knowledge_entity;
REMOVE FIELD IF EXISTS altEmbedding ON knowledge_fact;
