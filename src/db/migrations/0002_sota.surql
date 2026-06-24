-- 0002_sota — SurrealDB-native upgrades on top of the baseline.
--
-- 1. Text analyzers + BM25 SEARCH indexes for hybrid lexical retrieval.
-- 2. EntityExternalRef lookup table — replaces O(N) JS-side filter with
--    an indexed UNIQUE-keyed read; enables atomic resolve-or-create.
-- 3. canonicalNameLc materialised lower-form for case-insensitive
--    indexed name lookups (function expressions can't be indexed
--    directly in SurrealDB; we have to reify the result).
-- 4. Composite bitemporal index (entityId, status, recordedAt) so
--    profile + timeline queries with asOf are index-only, not
--    fact-table scans + JS filtering.
-- 5. UNIQUE on (in, out, kind) for knowledge_edge — RELATE becomes
--    idempotent; webhook replays no longer pollute the graph.
-- 6. CHANGEFEED on the three knowledge tables for canonical audit log
--    + downstream CDC. 30-day retention covers GDPR audit + debug
--    timeline + analytics warehouse sync without a separate Kafka
--    topic.

-- ─── Text analyzers ──────────────────────────────────────────────────────
DEFINE ANALYZER IF NOT EXISTS content
  TOKENIZERS class
  FILTERS lowercase, ascii, snowball(english);

DEFINE ANALYZER IF NOT EXISTS prefix
  TOKENIZERS class
  FILTERS lowercase, ascii, edgengram(2, 15);

-- ─── KnowledgeEntity additions ───────────────────────────────────────────
-- Re-declare the table with CHANGEFEED. SurrealDB v2 allows this as an
-- alteration when the table already exists; with IF NOT EXISTS plus the
-- existing baseline it's a no-op except for the CHANGEFEED clause being
-- attached on first apply of this migration.
DEFINE TABLE IF NOT EXISTS knowledge_entity SCHEMAFULL CHANGEFEED 30d INCLUDE ORIGINAL;

-- canonicalNameLc — materialised lower-form of canonicalName for
-- indexed case-insensitive lookups. Marked option<string> rather than
-- string: SurrealDB v2 type-checks the input BEFORE evaluating VALUE,
-- so a strict `string` type rejects the CREATE because the caller
-- doesn't supply canonicalNameLc explicitly. With option<string>, the
-- field accepts NONE input, then VALUE overrides it to the computed
-- lowercase form before storage.
DEFINE FIELD IF NOT EXISTS canonicalNameLc ON knowledge_entity
  TYPE option<string> VALUE string::lowercase(canonicalName);

DEFINE INDEX IF NOT EXISTS entity_canonical_lc_idx ON knowledge_entity FIELDS canonicalNameLc;
DEFINE INDEX IF NOT EXISTS entity_aliases_idx     ON knowledge_entity FIELDS aliases;

DEFINE INDEX IF NOT EXISTS entity_name_search_idx ON knowledge_entity
  FIELDS canonicalName FULLTEXT ANALYZER content BM25 HIGHLIGHTS;
DEFINE INDEX IF NOT EXISTS entity_alias_search_idx ON knowledge_entity
  FIELDS aliases FULLTEXT ANALYZER content BM25;

-- ─── EntityExternalRef (lookup table) ────────────────────────────────────
DEFINE TABLE IF NOT EXISTS entity_external_ref SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS key       ON entity_external_ref TYPE string;
DEFINE FIELD IF NOT EXISTS entity    ON entity_external_ref TYPE record<knowledge_entity>;
DEFINE FIELD IF NOT EXISTS createdAt ON entity_external_ref TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS entity_external_ref_key_idx ON entity_external_ref FIELDS key UNIQUE;
DEFINE INDEX IF NOT EXISTS entity_external_ref_ent_idx ON entity_external_ref FIELDS entity;

-- ─── KnowledgeFact additions ─────────────────────────────────────────────
DEFINE TABLE IF NOT EXISTS knowledge_fact SCHEMAFULL CHANGEFEED 30d INCLUDE ORIGINAL;

DEFINE INDEX IF NOT EXISTS fact_bitemporal_idx ON knowledge_fact
  FIELDS entityId, status, recordedAt;

DEFINE INDEX IF NOT EXISTS fact_object_search_idx ON knowledge_fact
  FIELDS object FULLTEXT ANALYZER content BM25 HIGHLIGHTS;

-- ─── KnowledgeEdge additions ─────────────────────────────────────────────
DEFINE TABLE IF NOT EXISTS knowledge_edge SCHEMAFULL TYPE RELATION
  IN knowledge_entity OUT knowledge_entity
  CHANGEFEED 30d INCLUDE ORIGINAL;

DEFINE INDEX IF NOT EXISTS edge_unique_idx ON knowledge_edge FIELDS in, out, kind UNIQUE;
DEFINE INDEX IF NOT EXISTS edge_in_idx     ON knowledge_edge FIELDS in;
DEFINE INDEX IF NOT EXISTS edge_out_idx    ON knowledge_edge FIELDS out;
