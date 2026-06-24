-- 0026_dream_emit — per-emit drill table for Dreams runs.
--
-- DreamsService creates identity_links (dedup) and supersede facts
-- (resolve) but until now there was no way to ask "which specific
-- merges did the 04:00 UTC dream produce yesterday for tenant X?".
-- The aggregate counters (identityLinksCreated, resolutionsApplied)
-- left the data on the floor.
--
-- This table captures one row per emit, joined back to the parent
-- job_run via runId. Retention is application-side (DreamsService
-- prunes rows past N days based on DREAMS_HISTORY_DAYS).

DEFINE TABLE IF NOT EXISTS dream_emit SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS runId ON dream_emit TYPE string;
-- Joins to job_run.runId (within the same tenant DB).
DEFINE FIELD IF NOT EXISTS kind ON dream_emit TYPE string;
-- 'identity_link' | 'resolution' | 'summary'.
DEFINE FIELD IF NOT EXISTS ts ON dream_emit TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS subject ON dream_emit TYPE option<string>;
-- Free-form pointer: for identity_link the canonical entityId of the
-- surviving record; for resolution the factId of the winner; for
-- summary the entityId/predicate the summary covers.
DEFINE FIELD IF NOT EXISTS object ON dream_emit TYPE option<string>;
-- Sibling pointer: for identity_link the loser entityId; for
-- resolution the loser factId.
DEFINE FIELD IF NOT EXISTS detail ON dream_emit TYPE option<object> FLEXIBLE;
-- Free-form judge output (similarity scores, judge reason, etc).

DEFINE INDEX IF NOT EXISTS dream_emit_run_idx
    ON dream_emit FIELDS runId;
DEFINE INDEX IF NOT EXISTS dream_emit_run_kind_idx
    ON dream_emit FIELDS runId, kind;
DEFINE INDEX IF NOT EXISTS dream_emit_ts_idx
    ON dream_emit FIELDS ts;
