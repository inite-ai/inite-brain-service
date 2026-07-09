-- 0049_candidates — the Indexer-run ledger + the Candidates staging layer.
--
-- Ingest architecture split (Source → Indexer → Candidates → Brain), part 2.
-- An indexer reads a document and says "I think this MIGHT be a fact" —
-- that hypothesis is a `candidate` row, NOT memory. The Brain commit step
-- (CandidateCommitService) later merges candidates across indexers,
-- resolves entities once, and drives the existing fn::resolve_fact —
-- candidates are the only pre-commit staging the graph has ever had
-- (ingest_dead_letter is a reject sink, post-commit statuses are not
-- staging).
--
-- Scope decisions (deliberate):
--   * `indexer_run` is one row per (document × pack × pack version) —
--     UNIQUE on that triple is the idempotency ledger for both multi-
--     indexer fan-out and re-indexing (a re-index INSERTs the run first;
--     a unique violation means "already processed, skip"). packId
--     '_general' is the pack-less generalist (union) pass.
--   * ONE `candidate` table with a `kind` discriminator, not three:
--     candidates are always read as a whole-document batch by the Brain,
--     payload shapes are validated in TS before the row is written
--     (ExtractionResult), and one table = one status index, one sweeper,
--     one metrics query. `payload` is FLEXIBLE — the domain_pack.manifest
--     "TS owns the shape" precedent.
--   * Cross-references between candidates stay index-based WITHIN a run
--     (payload.entityIndex), exactly mirroring extractor output — no
--     record-link plumbing.
--   * commitRef is a string, not record<> — it may point at a
--     knowledge_fact, knowledge_entity, or knowledge_edge.
--   * Lifecycle: pending → committed (drove a resolver/entity/edge write)
--     | merged (folded into another candidate's commit) | duplicate
--     (identical within the same doc) | rejected (low confidence, orphan
--     entityIndex, resolver REJECTED) | expired (sweeper TTL). SurrealDB
--     has no row TTL — the candidate_sweeper job owns cleanup.

DEFINE TABLE IF NOT EXISTS indexer_run SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS docId       ON indexer_run TYPE record<source_document>;
DEFINE FIELD IF NOT EXISTS packId      ON indexer_run TYPE string;
DEFINE FIELD IF NOT EXISTS packVersion ON indexer_run TYPE string;
DEFINE FIELD IF NOT EXISTS model       ON indexer_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS registryVersionHash ON indexer_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status      ON indexer_run TYPE string DEFAULT 'pending'
  ASSERT $value INSIDE ['pending','running','succeeded','failed','skipped'];
DEFINE FIELD IF NOT EXISTS stats       ON indexer_run TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS error       ON indexer_run TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS createdAt   ON indexer_run TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS finishedAt  ON indexer_run TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS indexer_run_identity_idx
  ON indexer_run FIELDS docId, packId, packVersion UNIQUE;
DEFINE INDEX IF NOT EXISTS indexer_run_status_idx ON indexer_run FIELDS status;

DEFINE TABLE IF NOT EXISTS candidate SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS docId     ON candidate TYPE record<source_document>;
DEFINE FIELD IF NOT EXISTS runId     ON candidate TYPE record<indexer_run>;
DEFINE FIELD IF NOT EXISTS chunkSeq  ON candidate TYPE int;
DEFINE FIELD IF NOT EXISTS kind      ON candidate TYPE string
  ASSERT $value INSIDE ['entity','fact','relation'];
-- entity:   { entityIndex, name, type, canonical?, indexerId }
-- fact:     { entityIndex, predicate, object, clause?, indexerId,
--             extractionEntropy?, extractionAgreement? }
-- relation: { fromEntityIndex, toEntityIndex, kind, clause?, indexerId }
-- plus provenance { packVersion, executionMode, model } on all kinds.
DEFINE FIELD IF NOT EXISTS payload   ON candidate TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS confidence ON candidate TYPE float DEFAULT 0.5;
DEFINE FIELD IF NOT EXISTS status    ON candidate TYPE string DEFAULT 'pending'
  ASSERT $value INSIDE ['pending','committed','merged','duplicate','rejected','expired'];
DEFINE FIELD IF NOT EXISTS statusReason ON candidate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS commitRef ON candidate TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON candidate TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS decidedAt ON candidate TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS candidate_doc_idx    ON candidate FIELDS docId, status;
DEFINE INDEX IF NOT EXISTS candidate_run_idx    ON candidate FIELDS runId;
DEFINE INDEX IF NOT EXISTS candidate_status_idx ON candidate FIELDS status, createdAt;
