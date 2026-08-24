-- 0102: reversible entity resolution — the merge/candidate audit log
-- (multilingual Tier 3). Companion to docs/roadmap/multilingual-2026-08.md.
--
-- WHY. Inline entity resolution (INGEST_INLINE_RESOLUTION_ENABLED,
-- entity-resolver.service.ts) REUSES an existing entity id the instant the
-- shared EntityJudge says "same", and the caller adopts that id immediately
-- (graphiti-parity). The reuse materialises NO `identity_of` edge, so a
-- WRONG merge — two different "John Smith"s fused on a near-identical name
-- embedding — leaves nothing to unlink. Tier 3 makes the decision AUDITABLE
-- and REVERSIBLE: every reuse appends a row here recording mention → target
-- entity, the judge verdict, the cosine, the matchKind, and (for weak
-- embedding-only matches under MULTILINGUAL_ENTITY_REVERSIBLE) a REVIEW
-- state, so a bad fuse can be found by target and split.
--
-- ADDITIVE + OPTIONAL by construction (the 0098-0101 posture): one new
-- table, every write gated OFF by MULTILINGUAL_ENTITY_REVERSIBLE at the
-- service layer. Flag off ⇒ nothing writes this table and the resolver's
-- reuse path is byte-identical to pre-0102. No migrate-time data mutation;
-- OVERWRITE-safe (every statement is IF NOT EXISTS, re-runnable).
--
-- NAMESPACED externalRef UNIQUENESS — ALREADY PRESENT (verified, so NOT
-- re-declared here). The tenant-namespaced external reference + its
-- uniqueness constraint is the `entity_external_ref` table from migration
-- 0002: `key` folds (vertical, id) via externalRefKey() and the per-user
-- scope (0055) into one string, guarded by
-- `entity_external_ref_key_idx ... UNIQUE`. Every tenant is a separate
-- SurrealDB database, so that key is tenant-scoped by physical isolation.
-- Re-adding a second UNIQUE on the same axis would only risk a conflicting
-- constraint; matchKind 'externalRef' below records reuse THROUGH that
-- existing mechanism.

DEFINE TABLE IF NOT EXISTS entity_merge_log SCHEMAFULL;

-- Owning tenant. Rows are ALSO physically scoped to the per-company DB via
-- withCompany (the authoritative tenant boundary, as everywhere else); this
-- column is optional and reserved for a future cross-tenant merge audit —
-- the posture focus_signal_sample (0094) documents. NONE when the writer
-- has no companyId in hand (the ingest resolver path).
DEFINE FIELD IF NOT EXISTS companyId ON entity_merge_log TYPE option<string>;

-- The incoming extracted surface (the mention name) that triggered the
-- decision, plus its normalized entity type.
DEFINE FIELD IF NOT EXISTS mention     ON entity_merge_log TYPE string;
DEFINE FIELD IF NOT EXISTS mentionType ON entity_merge_log TYPE option<string>;

-- The existing entity the mention matched. Stored as the id STRING (an
-- opaque provenance ref — the strategy_memory.outcomeEvidenceRef idiom of
-- 0098) rather than a record<> link: an audit row must survive its target
-- being retracted / split without a dangling-link constraint. A split tool
-- reads all rows WHERE targetEntity = $id to find every mention fused in.
DEFINE FIELD IF NOT EXISTS targetEntity ON entity_merge_log TYPE string;

-- The shared EntityJudge verdict at decision time.
DEFINE FIELD IF NOT EXISTS verdict ON entity_merge_log TYPE option<string>
    ASSERT $value IS NONE OR $value IN ['same', 'different', 'unsure'];

-- Cosine similarity of the winning name candidate (1.0 for an exact /
-- externalRef match that did not go through the embedding scan).
DEFINE FIELD IF NOT EXISTS cosine ON entity_merge_log TYPE option<float>
    ASSERT $value IS NONE OR ($value >= -1 AND $value <= 1);

-- HOW the match was made. 'translit' is RESERVED for the DEFERRED
-- transliteration-based candidate generator (Node has no built-in
-- transliterator; a vetted ICU-transliteration dep is a supply-chain /
-- owner decision). The enum carries it now so that follow-up needs NO
-- migration.
DEFINE FIELD IF NOT EXISTS matchKind ON entity_merge_log TYPE string
    ASSERT $value IN ['exact', 'externalRef', 'translit', 'embedding'];

-- What the resolver DID:
--   reused    — auto-adopted the existing id (strong exact / externalRef
--               match); deterministic, no review needed (reviewState NONE).
--   candidate — a weak embedding-only match was NOT auto-merged; a fresh
--               entity was minted instead and this row is queued for review.
DEFINE FIELD IF NOT EXISTS decision ON entity_merge_log TYPE string
    ASSERT $value IN ['reused', 'candidate'];

-- Review lifecycle for a candidate row (NONE for a deterministic reused
-- row). 'pending' on write; a reviewer / split tool advances it.
DEFINE FIELD IF NOT EXISTS reviewState ON entity_merge_log TYPE option<string>
    ASSERT $value IS NONE OR $value IN ['pending', 'confirmed', 'split'];

DEFINE FIELD IF NOT EXISTS createdAt ON entity_merge_log TYPE datetime
    DEFAULT time::now();

-- Find every mention fused into (or proposed for) one entity → the split path.
DEFINE INDEX IF NOT EXISTS entity_merge_log_target_idx ON entity_merge_log
    FIELDS targetEntity;
-- Page the review queue by recency; filter pending candidates by state.
DEFINE INDEX IF NOT EXISTS entity_merge_log_review_idx ON entity_merge_log
    FIELDS reviewState, createdAt;
