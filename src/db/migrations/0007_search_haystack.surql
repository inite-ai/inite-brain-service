-- 0007_search_haystack — broaden the lexical-search surface beyond
-- raw fact.object.
--
-- Why: the lexical leg of hybrid search currently only indexes
-- `knowledge_fact.object`. Queries like "complaints from tenants"
-- semantically target the *predicate* (`complained_about`) but BM25
-- never sees the predicate field, so it misses the obvious lexical
-- bridge. Snowball stemming across `complain` ↔ `complained` only
-- helps if `complained` is in the indexed text.
--
-- Fix: a derived `searchHaystack` field that concatenates a
-- whitespace-normalised predicate and the object into one BM25
-- surface. Underscores in canonical predicate names
-- (`complained_about`) are converted to spaces so the tokenizer
-- splits them, then snowball stems them, so a query "complain"
-- matches a fact whose predicate is `complained_about`.
--
-- Tradeoff: object stays on its own search index (`fact_object_search_idx`)
-- so callers that explicitly want object-only matches keep that
-- precision. The new index is additive — both can be queried in
-- `OR`, with the BM25 score per-field exposed via `search::score(N)`.

-- VALUE on a non-option field is evaluated AFTER the field-type
-- check on CREATE, which fails because the caller doesn't supply
-- searchHaystack. Same workaround as canonicalNameLc in 0002:
-- declare option<string> so NONE is a valid input, then VALUE
-- materialises it on every write.
DEFINE FIELD IF NOT EXISTS searchHaystack ON knowledge_fact
  TYPE option<string>
  VALUE string::concat(string::replace(predicate, '_', ' '), ' ', object);

-- Backfill: VALUE only fires on writes; existing rows from earlier
-- migrations have searchHaystack=NONE. Touch each row to recompute.
-- A no-op SET on `predicate` is enough; the field's TYPE already
-- forbids invalid values, so the SET round-trips safely.
UPDATE knowledge_fact SET searchHaystack = string::concat(string::replace(predicate, '_', ' '), ' ', object);

DEFINE INDEX IF NOT EXISTS fact_haystack_search_idx ON knowledge_fact
  FIELDS searchHaystack SEARCH ANALYZER content BM25 HIGHLIGHTS;
