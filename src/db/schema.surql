-- INITE Brain Service — per-tenant database schema
--
-- Conformance: inite-ecosystem/core/services/brain.yaml + core/capabilities/knowledge.yaml
-- Applied per tenant: NS=brain DB=co_<companyId>
--
-- All tables are bitemporal where applicable:
--   validFrom/validUntil   — when the fact was true in the real world
--   recordedAt/retractedAt — when brain knew it
--
-- Forget at the tenant level = REMOVE DATABASE (single-statement cascade).

-- ─── KnowledgeEntity ─────────────────────────────────────────────────────
DEFINE TABLE knowledge_entity SCHEMAFULL;

DEFINE FIELD type            ON knowledge_entity TYPE string
  ASSERT $value INSIDE ['customer','staff','asset','project','topic','location','other'];
DEFINE FIELD canonicalName   ON knowledge_entity TYPE string;
DEFINE FIELD aliases         ON knowledge_entity TYPE option<array<string>>;
-- FLEXIBLE keeps arbitrary dynamic keys (vertical.entityId pairs) on a
-- SCHEMAFULL table. Without it, SurrealDB drops unknown sub-fields silently.
DEFINE FIELD externalRefs    ON knowledge_entity FLEXIBLE TYPE object DEFAULT {};
DEFINE FIELD createdAt       ON knowledge_entity TYPE datetime DEFAULT time::now();
DEFINE FIELD mergedAt        ON knowledge_entity TYPE option<datetime>;
DEFINE FIELD mergedInto      ON knowledge_entity TYPE option<record<knowledge_entity>>;
DEFINE FIELD embedding       ON knowledge_entity TYPE option<array<float>>;

DEFINE INDEX entity_type_idx        ON knowledge_entity FIELDS type;
DEFINE INDEX entity_canonical_idx   ON knowledge_entity FIELDS canonicalName;
-- HNSW vector index is opt-in per tenant once the graph grows past ~50k
-- active facts. For walking-skeleton scale, full-scan cosine in
-- SearchService is faster end-to-end (no index build).
-- DEFINE INDEX entity_embedding_idx ON knowledge_entity FIELDS embedding
--   HNSW DIMENSION 1536 DIST COSINE EFC 200 M 16;

-- ─── KnowledgeFact ───────────────────────────────────────────────────────
DEFINE TABLE knowledge_fact SCHEMAFULL;

DEFINE FIELD entityId         ON knowledge_fact TYPE record<knowledge_entity>;
DEFINE FIELD predicate        ON knowledge_fact TYPE string;
DEFINE FIELD object           ON knowledge_fact TYPE string;
DEFINE FIELD objectMeta       ON knowledge_fact FLEXIBLE TYPE option<object>;
DEFINE FIELD confidence       ON knowledge_fact TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD validFrom        ON knowledge_fact TYPE datetime;
DEFINE FIELD validUntil       ON knowledge_fact TYPE option<datetime>;
DEFINE FIELD recordedAt       ON knowledge_fact TYPE datetime DEFAULT time::now();
DEFINE FIELD retractedAt      ON knowledge_fact TYPE option<datetime>;
DEFINE FIELD retractionReason ON knowledge_fact TYPE option<string>;
DEFINE FIELD retractedBy      ON knowledge_fact TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['human','system','cascade'];
DEFINE FIELD supersededBy     ON knowledge_fact TYPE option<record<knowledge_fact>>;
DEFINE FIELD source           ON knowledge_fact FLEXIBLE TYPE object;
DEFINE FIELD derivedFrom      ON knowledge_fact TYPE option<array<record<knowledge_fact>>>;
DEFINE FIELD status           ON knowledge_fact TYPE string DEFAULT 'active'
  ASSERT $value INSIDE ['active','competing','retracted','superseded','compacted'];
DEFINE FIELD embedding        ON knowledge_fact TYPE option<array<float>>;

DEFINE INDEX fact_entity_idx        ON knowledge_fact FIELDS entityId;
DEFINE INDEX fact_predicate_idx     ON knowledge_fact FIELDS predicate;
DEFINE INDEX fact_status_idx        ON knowledge_fact FIELDS status;
DEFINE INDEX fact_recorded_idx      ON knowledge_fact FIELDS recordedAt;
DEFINE INDEX fact_entity_pred_idx   ON knowledge_fact FIELDS entityId, predicate, status;
-- HNSW commented out — see knowledge_entity above.
-- DEFINE INDEX fact_embedding_idx ON knowledge_fact FIELDS embedding
--   HNSW DIMENSION 1536 DIST COSINE EFC 200 M 16;

-- ─── KnowledgeEdge ───────────────────────────────────────────────────────
-- Surreal graph relations are first-class. We model edges as a `RELATE`-able
-- table so we can use both property-based queries and graph traversal.
DEFINE TABLE knowledge_edge SCHEMAFULL TYPE RELATION
  IN knowledge_entity OUT knowledge_entity;

DEFINE FIELD kind            ON knowledge_edge TYPE string;
DEFINE FIELD weight          ON knowledge_edge TYPE float DEFAULT 1.0
  ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD source          ON knowledge_edge FLEXIBLE TYPE object;
DEFINE FIELD createdAt       ON knowledge_edge TYPE datetime DEFAULT time::now();
DEFINE FIELD invalidatedAt   ON knowledge_edge TYPE option<datetime>;

DEFINE INDEX edge_kind_idx      ON knowledge_edge FIELDS kind;

-- ─── ForgottenEntity (GDPR audit) ────────────────────────────────────────
-- Tombstone retained after a hard forget. ONLY HMAC hash + reason. No
-- plaintext id of the deleted entity.
DEFINE TABLE forgotten_entity SCHEMAFULL;

DEFINE FIELD entityIdHash    ON forgotten_entity TYPE string;
DEFINE FIELD reason          ON forgotten_entity TYPE string
  ASSERT $value INSIDE ['gdpr_request','tenant_offboarding','operator_request'];
DEFINE FIELD requestId       ON forgotten_entity TYPE string;
DEFINE FIELD factsDeleted    ON forgotten_entity TYPE int DEFAULT 0;
DEFINE FIELD edgesDeleted    ON forgotten_entity TYPE int DEFAULT 0;
DEFINE FIELD forgottenAt     ON forgotten_entity TYPE datetime DEFAULT time::now();

DEFINE INDEX forgotten_hash_idx ON forgotten_entity FIELDS entityIdHash UNIQUE;

-- ─── DeadLetter (rejected ingests) ───────────────────────────────────────
DEFINE TABLE ingest_dead_letter SCHEMAFULL;

DEFINE FIELD payload     ON ingest_dead_letter TYPE object;
DEFINE FIELD reason      ON ingest_dead_letter TYPE string;
DEFINE FIELD rejectedAt  ON ingest_dead_letter TYPE datetime DEFAULT time::now();
