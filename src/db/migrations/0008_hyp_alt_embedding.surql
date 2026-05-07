-- 0008_hyp_alt_embedding — HyPE-style alternative embedding per fact.
--
-- Why: the main `embedding` field encodes the literal `object` text
-- ("broken washing machine in unit 4B"). Many user queries arrive in
-- question form ("who has appliance issues?") whose embedding sits
-- in a different region of the vector space than the statement
-- form. Cross-encoder reranking helps but pays a per-query LLM call;
-- a precomputed hypothetical-question embedding closes much of the
-- question→statement gap at retrieval time without any LLM call on
-- the read path.
--
-- Mechanism: at ingest, generate ONE hypothetical question that
-- would be naturally answered by the fact (e.g. "Who reported a
-- broken washing machine?") and embed it. Store as `altEmbedding`.
-- At search, the vector leg takes max(cosine(main), cosine(alt))
-- — the better of the two paths matters, not their average.
--
-- Backwards-compat: existing facts keep `altEmbedding=NONE` and
-- the search query gracefully treats NONE as -1 (max ignores them).
-- New facts get the alt-embedding when SEARCH_HYPE_ENABLED=1 at
-- ingest. Pre-existing facts can be backfilled by re-ingesting
-- (out of scope for this migration).

DEFINE FIELD IF NOT EXISTS altEmbedding ON knowledge_fact
  TYPE option<array<float>>;
