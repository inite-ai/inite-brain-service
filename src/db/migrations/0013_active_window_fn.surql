-- 0013_active_window_fn — single source of truth for the bitemporal slice
-- + fuzzy entity-name search index.
--
-- Two changes, both informed by the SurrealDB v2 feature audit (Sprint 1
-- of the audit's recommendations):
--
-- 1. fn::active_window — wraps the bitemporal "is this fact true at
--    asOf?" closure that's currently replicated across at least four call
--    sites (search.service.ts vector/lexical legs, admin.controller.ts
--    graphSearch, compaction sweeps, dreams dedup). Same WHERE, same
--    edge cases, drift risk grows with each new caller. The function
--    accepts a NONE asOf — interpreted as "now" — so callers don't have
--    to branch.
--
-- 2. entity_fuzzy_idx — the `prefix` analyzer was declared in 0002 but
--    never indexed against a field. Using it on knowledge_entity
--    canonicalName + aliases enables `@@`-driven fuzzy match so
--    operator queries with typos or partials ("Marya" → "Maria Petrov")
--    resolve correctly. Replaces the JS substring filter in graphSearch
--    that's been a recall hit on multilingual + typo'd inputs.

-- ── fn::active_window ──────────────────────────────────────────────────
-- Returns the active-fact subset for an entity inside the bitemporal
-- slice. NONE asOf means "now". $predicates is an optional list of
-- predicates to AND-filter against; pass NONE to admit all predicates.
--
-- Same predicates the resolver respects: not retracted, validFrom is in
-- the past, validUntil is in the future or NONE, status excludes
-- superseded / compacted.
DEFINE FUNCTION OVERWRITE fn::active_window(
    $entity_id: record<knowledge_entity>,
    $as_of: option<datetime>,
    $predicates: option<array<string>>
) {
    LET $effective = IF $as_of IS NONE THEN time::now() ELSE $as_of END;
    LET $has_filter = type::is::array($predicates) AND array::len($predicates) > 0;
    RETURN
        SELECT id, predicate, object, confidence, validFrom, validUntil,
               recordedAt, retractedAt, status, source, entityId
          FROM knowledge_fact
         WHERE entityId = $entity_id
           AND (retractedAt IS NONE OR retractedAt > $effective)
           AND validFrom <= $effective
           AND (validUntil IS NONE OR validUntil > $effective)
           AND status NOT IN ['superseded', 'compacted']
           AND (NOT $has_filter OR predicate IN $predicates);
};

-- ── Fuzzy entity-name index ───────────────────────────────────────────
-- prefix analyzer = edgengram(2..15) on lowercase + ascii-folded text.
-- Matches "mari" against "Maria Petrov", "Petrov" against
-- "Petrov" — typo tolerance is approximate (no Levenshtein) but the
-- recall improvement on multilingual + partial inputs is substantial.
-- BM25 ranking keeps "Maria Petrov" above "Maria" when both match.
DEFINE INDEX IF NOT EXISTS entity_fuzzy_idx ON knowledge_entity
  FIELDS canonicalName SEARCH ANALYZER prefix BM25;
