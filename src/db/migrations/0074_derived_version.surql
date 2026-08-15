-- 0074_derived_version — versioned derivation namespaces
-- (docs/roadmap/memory-substrate-redesign-2026-07.md §2.2, P3 v1).
--
-- THE A/B THIS ENABLES. Re-deriving memory from the L0 episode substrate
-- with an improved deriver must not clobber the incumbent facts: the
-- design review showed a batch re-derivation routed through
-- fn::resolve_fact would supersede v1 incumbents AT WRITE TIME,
-- destroying the baseline before any read-path switch. v1 of the fix is
-- namespace isolation: derived facts carry `derivedVersion`, the read
-- path pins exactly one namespace (RETRIEVAL_DERIVED_VERSION; unset =
-- legacy rows where the field is NONE), and a batch deriver owns its
-- namespace wholesale (delete-by-version, then create — no resolver).
-- Version-scoped resolve_fact candidates (incremental prod derivation)
-- are the P3-full follow-up.

DEFINE FIELD IF NOT EXISTS derivedVersion ON knowledge_fact TYPE option<string>;

-- The read path filters every leg on this; without an index the pin is a
-- full scan per query.
DEFINE INDEX IF NOT EXISTS fact_derived_version_idx ON knowledge_fact
  FIELDS derivedVersion;
