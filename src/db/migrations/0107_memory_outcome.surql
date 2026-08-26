-- 0107_memory_outcome — append-only outcome telemetry, storage side.
--
-- fact_usage (0053) records that search SURFACED a fact; nothing records
-- what happened AFTER — whether the fact was selected into a prompt,
-- cited in an answer, verified as supporting it, confirmed/rejected by a
-- consumer, or contradicted by later ingest. This pair is the outcome
-- substrate the verified-use ranking work will read:
--   * memory_outcome      — the append-only raw event log;
--   * memory_outcome_stat — a per-subject rollup maintained on the write
--     path (one indexed row per subject — the ranking currency).
--
-- A SEPARATE table pair, not fields on knowledge_fact: the 0053
-- rationale carries over verbatim —
--   * "knowledge_fact sits on a CHANGEFEED mirrored into audit_event —
--     per-search counter bumps would flood the audit trail;"
--   * "knowledge_artifact has a DEFINE EVENT that marks artifacts dirty
--     on ANY fact change — usage stamps would recompile artifacts for
--     nothing;"
--   * "the ingest path serializes fact writes per (entity, predicate)
--     through a KeyedMutex — read-path writes must not contend there."
-- Telemetry must touch none of those surfaces.
--
-- Why the rollup is a normal write-path table and NOT a 0088 computed
-- view: lastVerifiedUseAt is a MAX — non-invertible, an incremental view
-- cannot process a raw-row DELETE — and the retention cron PRUNES raw
-- rows, which would decrement any incremental count view. The rollup
-- must SURVIVE raw-row pruning, so the writer maintains it directly
-- (INSERT … ON DUPLICATE KEY UPDATE over the UNIQUE subjectId index)
-- and it is never recomputed from the raw table.
--
-- Growth bounds:
--   * memory_outcome ≤ event volume × OUTCOME_EVENT_RETENTION_DAYS —
--     the nightly prune cron (03:41 UTC) deletes older rows in bounded
--     batches; writers cap events per request;
--   * memory_outcome_stat ≤ 1 row per subject (UNIQUE subjectId).
--
-- NO CHANGEFEED and NO DEFINE EVENT — deliberately. Mirroring telemetry
-- into audit_event would reintroduce exactly the flood 0053 avoided, and
-- a DEFINE EVENT on a high-volume append table is a write amplifier.
--
-- meta is CONTENT-FREE by contract: record ids / verdict strings only,
-- NEVER fact text. That is what lets the GDPR entity-forget bulk-purge
-- run OUTSIDE the atomic erase transaction (an aborted erase merely
-- deleted telemetry early) and keeps these tables out of the PII
-- reconstruction surface.

DEFINE TABLE IF NOT EXISTS memory_outcome SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS subjectKind ON memory_outcome TYPE string
  ASSERT $value INSIDE ['fact', 'episode', 'belief', 'evidence'];
-- Untyped record — generic over subject tables, still traversable
-- (subjectId.userId / subjectId.entityId in the GDPR cascades).
DEFINE FIELD IF NOT EXISTS subjectId   ON memory_outcome TYPE record;
DEFINE FIELD IF NOT EXISTS event       ON memory_outcome TYPE string
  ASSERT $value INSIDE ['retrieved', 'selected_for_context', 'used_in_answer',
    'verifier_supported', 'user_confirmed', 'user_rejected', 'contradicted'];
DEFINE FIELD IF NOT EXISTS actor       ON memory_outcome TYPE option<string>;
DEFINE FIELD IF NOT EXISTS requestId   ON memory_outcome TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt   ON memory_outcome TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS meta        ON memory_outcome TYPE option<object> FLEXIBLE;

DEFINE INDEX IF NOT EXISTS memory_outcome_subject_idx ON memory_outcome FIELDS subjectId, event;
DEFINE INDEX IF NOT EXISTS memory_outcome_created_idx ON memory_outcome FIELDS createdAt;

DEFINE TABLE IF NOT EXISTS memory_outcome_stat SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS subjectId         ON memory_outcome_stat TYPE record;
DEFINE FIELD IF NOT EXISTS subjectKind       ON memory_outcome_stat TYPE string
  ASSERT $value INSIDE ['fact', 'episode', 'belief', 'evidence'];
DEFINE FIELD IF NOT EXISTS selectedCount     ON memory_outcome_stat TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS usedCount         ON memory_outcome_stat TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS verifiedUseCount  ON memory_outcome_stat TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS confirmedCount    ON memory_outcome_stat TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS rejectedCount     ON memory_outcome_stat TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS contradictedCount ON memory_outcome_stat TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS lastUsedAt        ON memory_outcome_stat TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lastVerifiedUseAt ON memory_outcome_stat TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updatedAt         ON memory_outcome_stat TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS memory_outcome_stat_subject_idx ON memory_outcome_stat FIELDS subjectId UNIQUE;
