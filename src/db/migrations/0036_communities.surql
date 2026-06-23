-- 0036_communities — topic-level clustering of the entity graph.
--
-- Borrowed from graphiti (Zep) community detection: cluster the entity
-- graph into topic communities via label propagation, summarise each,
-- and expose a coarse retrieval scope alongside facts/entities. brain
-- had no clustering layer before this (only PPR cluster-lift inside the
-- fact search pipeline); a community is a first-class, persisted node.
--
-- Built off-hours by the dreams loop (CommunityBuilderService), gated
-- behind DREAMS_COMMUNITIES_ENABLED. Idempotent: each build replaces
-- the tenant's community set, reusing the summary when nothing changed.
--
-- Bi-temporal-flavoured WATERMARK (borrowed from graphiti summarize_saga):
--   lastBuiltAt        — wall-clock: when we last (re)built this node.
--   lastBuiltMaxEdgeAt — event-time: max knowledge_edge.createdAt that
--                        fed this cluster. The next build re-summarises a
--                        community ONLY when newer edges appeared, so a
--                        stable cluster never re-pays the LLM cost.
--
-- community_member is a RELATION (community_node -> knowledge_entity),
-- mirroring graphiti's HAS_MEMBER edge.

DEFINE TABLE IF NOT EXISTS community_node SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS label              ON community_node TYPE string;
DEFINE FIELD IF NOT EXISTS summary            ON community_node TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS summaryEmbedding   ON community_node TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS memberCount        ON community_node TYPE int DEFAULT 0
  ASSERT $value >= 0;
DEFINE FIELD IF NOT EXISTS algorithm          ON community_node TYPE string DEFAULT 'label_propagation';
DEFINE FIELD IF NOT EXISTS builtAt            ON community_node TYPE datetime DEFAULT time::now();
-- Watermarks (see header). Wall-clock + event-time, as in graphiti.
DEFINE FIELD IF NOT EXISTS lastBuiltAt        ON community_node TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lastBuiltMaxEdgeAt ON community_node TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS community_built_idx ON community_node FIELDS builtAt;
-- Full-text over the summary so the community scope can answer
-- "what do we know about <domain>" lexically. Same `content` analyzer
-- the fact / entity BM25 indexes use (migration 0002).
DEFINE INDEX IF NOT EXISTS community_summary_idx ON community_node
  FIELDS summary SEARCH ANALYZER content BM25 HIGHLIGHTS;
-- HNSW over the summary embedding is opt-in once a tenant grows many
-- communities; full-scan cosine in CommunityBuilderService is fine at
-- walking-skeleton scale (communities are O(10²), not O(facts)).
-- DEFINE INDEX community_embedding_idx ON community_node FIELDS summaryEmbedding
--   HNSW DIMENSION 1024 DIST COSINE EFC 200 M 16;

-- ─── community_member (community_node -> knowledge_entity) ───────────────
DEFINE TABLE IF NOT EXISTS community_member SCHEMAFULL TYPE RELATION
  IN community_node OUT knowledge_entity;

DEFINE FIELD IF NOT EXISTS addedAt ON community_member TYPE datetime DEFAULT time::now();

-- Each (community, entity) pair at most once. An entity belongs to one
-- community per build, but the UNIQUE guard keeps re-runs idempotent.
DEFINE INDEX IF NOT EXISTS member_unique_idx ON community_member FIELDS in, out UNIQUE;
DEFINE INDEX IF NOT EXISTS member_in_idx     ON community_member FIELDS in;
-- Hot path for retrieval: entity -> its community (carry the label as a
-- type hint into the listwise reranker).
DEFINE INDEX IF NOT EXISTS member_out_idx    ON community_member FIELDS out;
