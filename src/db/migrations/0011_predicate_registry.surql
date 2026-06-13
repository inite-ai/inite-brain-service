-- 0011_predicate_registry — extensible per-tenant predicate ontology.
--
-- Motivation: prior to this migration the predicate vocabulary and policy
-- table lived as a hardcoded TypeScript constant (PREDICATE_POLICIES in
-- conflict-resolver.ts). Adding a new predicate to support a different
-- vertical (medical / legal / real-estate) required a code edit and a
-- redeploy. That is anti-SOTA for memory layers — production systems
-- (Zep set_ontology, mem0 custom_categories, Cognee RDF/OWL,
-- Wikidata property catalog) all treat the ontology as governed data
-- with policy stored alongside the predicate, never compiled into the
-- extractor.
--
-- This migration creates the registry table. Seed data still flows from
-- the JS source-of-truth (CORE_PREDICATES in predicate-registry.service.ts)
-- via an idempotent INSERT-IF-NOT-EXISTS on first read per tenant — that
-- way adding a new core predicate is a code change AND a no-op redeploy
-- (the bootstrap fills it in), while tenant-specific predicates added
-- directly via admin / API persist independently.
--
-- Why per-tenant table (instead of a tenant_id column on a shared table):
--   - Each tenant already has its own database; the registry naturally
--     scopes to the same boundary.
--   - Admin edits in one tenant cannot affect another.
--   - Matches Wikidata's per-wiki property catalog model.
--
-- The fields encode three distinct axes — they should not be conflated:
--   - cardinality / time-behavior  → `semantics`
--   - read-time relevance decay   → `decayHalfLifeDays`
--   - access-control class        → `piiClass` + `requiresScope`

DEFINE TABLE IF NOT EXISTS knowledge_predicate SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS predicateId        ON knowledge_predicate TYPE string;
DEFINE FIELD IF NOT EXISTS displayLabel       ON knowledge_predicate TYPE string;
DEFINE FIELD IF NOT EXISTS description        ON knowledge_predicate TYPE string;
DEFINE FIELD IF NOT EXISTS datatype           ON knowledge_predicate TYPE string DEFAULT 'string';
DEFINE FIELD IF NOT EXISTS semantics          ON knowledge_predicate TYPE string
  ASSERT $value IN ['single_active', 'append_only', 'bitemporal'];
DEFINE FIELD IF NOT EXISTS decayHalfLifeDays  ON knowledge_predicate TYPE option<int>;
DEFINE FIELD IF NOT EXISTS piiClass           ON knowledge_predicate TYPE string
  ASSERT $value IN ['none', 'identifier', 'behavioral', 'text', 'sensitive'];
DEFINE FIELD IF NOT EXISTS requiresScope      ON knowledge_predicate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS parentPredicateId  ON knowledge_predicate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS subjectClasses     ON knowledge_predicate TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS allowedValues      ON knowledge_predicate TYPE option<array<string>>;
-- 'active'    = visible to extractor + retrievers
-- 'proposed'  = LLM auto-discovered, awaiting human/auto review
-- 'aliased'   = canonicalised to another predicate via aliasedTo
-- 'deprecated' = read-only; new facts are rejected
DEFINE FIELD IF NOT EXISTS status             ON knowledge_predicate TYPE string DEFAULT 'active'
  ASSERT $value IN ['active', 'proposed', 'aliased', 'deprecated'];
DEFINE FIELD IF NOT EXISTS aliasedTo          ON knowledge_predicate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdBy          ON knowledge_predicate TYPE string DEFAULT 'system'
  ASSERT $value IN ['system', 'admin', 'llm_auto', 'migration'];
DEFINE FIELD IF NOT EXISTS createdAt          ON knowledge_predicate TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt          ON knowledge_predicate TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS version            ON knowledge_predicate TYPE int       DEFAULT 1;

-- predicateId is the operator-facing identifier; uniqueness is enforced.
DEFINE INDEX IF NOT EXISTS knowledge_predicate_id_idx
  ON knowledge_predicate FIELDS predicateId UNIQUE;
-- Active-set lookup is the hot path (every extraction / router call
-- pulls all active predicates for the tenant via the cached snapshot).
DEFINE INDEX IF NOT EXISTS knowledge_predicate_status_idx
  ON knowledge_predicate FIELDS status;
