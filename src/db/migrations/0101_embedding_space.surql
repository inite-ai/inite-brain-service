-- 0101: embedding-space provenance (multilingual Tier 2).
--
-- WHY. Every table that stores a dense vector stores it in SOME embedding
-- space — a (model, dimensionality, normalization) triple. Today that
-- space is IMPLICIT: it is whatever `EMBEDDER_PROVIDER` happened to be
-- when the row was written. Flipping the embedder (openai 1536 → bge-m3
-- 1024, or a re-fit of the same model) silently MIXES spaces: a query
-- embedded in one space gets cosine-compared against rows written in
-- another, and the numbers are meaningless. `reindex-embeddings` only
-- rewrites knowledge_fact, so entity / predicate / episode / segment /
-- strategy vectors are left behind in the old space (hnsw-maintenance.ts
-- already acknowledges this hole).
--
-- Tier 2 makes the space EXPLICIT and per-row. `embeddingSpaceId` is a
-- canonical descriptor `provider:model:dim:norm`
-- (e.g. `openai:text-embedding-3-small:1536:l2`). With it, a serving
-- guard can refuse a cross-space compare, a reindex can stamp the space
-- it rewrote into, and a zero-downtime migration can dual-write + cut a
-- tenant over atomically.
--
-- ADDITIVE + OPTIONAL by construction (the 0098/0099/0100 posture): every
-- new column is option<string>, so EXISTING ROWS READ NONE and NO backfill
-- runs at migrate time. NONE is interpreted by the read path as "the
-- current provider's space" (the legacy/implicit space) — byte-identical
-- to pre-0101 behaviour. The write-time stamp is gated OFF by
-- EMBEDDING_SPACE_TRACKING at the service layer, so with the flag off these
-- columns are never written and never read. `embedding` / `altEmbedding` /
-- the per-table vector columns are kept AS-IS; embeddingSpaceId sits beside
-- them and describes the space they were produced in.
--
-- No migration-time data mutation: existing rows are re-stamped only by the
-- explicit, flag-gated reindex sweep (POST /v1/admin/reindex/embeddings),
-- never at migrate time.

-- Every embedding-bearing table gets one `embeddingSpaceId`. A single
-- column per row is correct even for knowledge_fact (which carries both
-- `embedding` and `altEmbedding`): both are produced by the SAME active
-- provider in one write, so they share one space descriptor.

-- knowledge_fact — the primary fact vector (`embedding`) + the HyPE
-- alternate vector (`altEmbedding`), both in the same space.
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON knowledge_fact TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- knowledge_entity — the entity-name/description vector.
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON knowledge_entity TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- knowledge_predicate — the predicate-registry embedding (0012).
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON knowledge_predicate TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- episode — the raw-turn substrate embedding (0073).
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON episode TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- episode_segment — the coverage-scan segment embedding (0075/0081).
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON episode_segment TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- strategy_memory — the experience-lane embedding (0092).
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON strategy_memory TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- community_node — the community-summary embedding (0036). Included for
-- completeness so the whole vector store can declare its space; the
-- reindex-all sweep does not regenerate summary vectors (they are derived
-- from a summarization pass, not a plain re-embed), so this column is
-- stamped only by a future community re-derive.
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON community_node TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- procedural_memory — the trigger embedding (0035). Same note as
-- community_node: additive column now, stamped by its own write path later.
DEFINE FIELD IF NOT EXISTS embeddingSpaceId ON procedural_memory TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;

-- ── Per-tenant active-space state (zero-downtime migration protocol) ──
--
-- The atomic cutover needs a durable, per-tenant record of WHICH space the
-- tenant currently serves reads from, plus (during a migration) the target
-- space it is dual-writing into. A single SCHEMAFULL row per tenant DB
-- (`embedding_space_state:current`) holds it. Unset / absent ⇒ the tenant
-- is wholly in the current provider's (legacy) space — the resolver
-- defaults to that, so serving is byte-identical until an operator begins a
-- migration. All fields optional; the table is inert unless
-- EMBEDDING_SPACE_ACTIVE is on.
DEFINE TABLE IF NOT EXISTS embedding_space_state SCHEMAFULL;
-- The space the read path selects for this tenant (NONE ⇒ current provider
-- space). A tenant is WHOLLY in one space at query time — never mixed.
DEFINE FIELD IF NOT EXISTS activeSpace ON embedding_space_state TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;
-- The space a migration is moving this tenant INTO (dual-write target).
-- NONE ⇒ no migration in flight.
DEFINE FIELD IF NOT EXISTS targetSpace ON embedding_space_state TYPE option<string>
    ASSERT $value IS NONE OR string::len($value) >= 3;
-- True while shadow dual-write is arming the target space's vectors.
DEFINE FIELD IF NOT EXISTS dualWrite ON embedding_space_state TYPE bool DEFAULT false;
-- Audit: when the state last changed and what phase it is in.
DEFINE FIELD IF NOT EXISTS phase ON embedding_space_state TYPE option<string>
    ASSERT $value IS NONE OR $value IN ['idle', 'dual_write', 'cut_over'];
DEFINE FIELD IF NOT EXISTS updatedAt ON embedding_space_state TYPE datetime DEFAULT time::now();
