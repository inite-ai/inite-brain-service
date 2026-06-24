-- 0025_job_run — generic long-running operator job log.
--
-- Until now every long-running pipeline (reindex, dreams, calibration
-- refit, compaction, changefeed drain) returned its summary in the
-- HTTP response and otherwise vanished. Operators had no way to:
--   - see history of past runs
--   - resume from a checkpoint after pod crash
--   - cancel a running job
--   - drill into per-tenant progress for a single run
--
-- This migration declares `job_run` as the per-tenant projection
-- of generic job state. One row per (jobType, runId). Updated by the
-- JobRunService as the job progresses; readable by operators via
-- /v1/admin/jobs.
--
-- Per-tenant placement (inside the tenant DB) is deliberate: the
-- audit_event + debug_trace + scheduler_state pattern already
-- live there, and the SurrealService.withCompany helper expects it.
-- Cross-tenant rollups are computed in the AdminService.

DEFINE TABLE IF NOT EXISTS job_run SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS runId ON job_run TYPE string;
-- Stable per-run UUID; surfaced in HTTP responses + audit log.
DEFINE FIELD IF NOT EXISTS jobType ON job_run TYPE string;
-- One of: 'dreams' | 'compaction' | 'calibration_refit' |
-- 'source_trust_refit' | 'reindex_embeddings' | 'changefeed_drain'.
-- Stored as string (not enum) so adding new job types doesn't need
-- a migration cascade.
DEFINE FIELD IF NOT EXISTS status ON job_run TYPE string;
-- 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'.
DEFINE FIELD IF NOT EXISTS triggeredBy ON job_run TYPE string DEFAULT 'cron';
-- 'cron' | 'manual' | 'startup'. Distinguishes operator-triggered runs
-- from scheduled ones for audit and capacity planning.
DEFINE FIELD IF NOT EXISTS triggeredByActor ON job_run TYPE option<string>;
-- For 'manual': the brain:admin caller (companyId from the API key).
DEFINE FIELD IF NOT EXISTS startedAt ON job_run TYPE datetime
    DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS finishedAt ON job_run TYPE option<datetime>;
-- Set on transition to terminal status. Subtract startedAt for duration.
DEFINE FIELD IF NOT EXISTS progress ON job_run TYPE option<object> FLEXIBLE;
-- Free-form progress hash. Conventional keys:
--   { processed: number, total?: number, currentTenant?: string,
--     itemsEmitted?: number, partialStats?: any }
-- The job is the source of truth for shape; UI renders whatever is here.
DEFINE FIELD IF NOT EXISTS result ON job_run TYPE option<object> FLEXIBLE;
-- Terminal payload; mirrors what the legacy synchronous HTTP response
-- returned (so callers waiting on the run can read it back from DB).
DEFINE FIELD IF NOT EXISTS error ON job_run TYPE option<object> FLEXIBLE;
-- { message: string, name?: string, stack?: string } on failure.
DEFINE FIELD IF NOT EXISTS cancelRequested ON job_run TYPE bool
    DEFAULT false;
-- Long-running jobs poll this between batches to honour /cancel calls.

DEFINE INDEX IF NOT EXISTS job_run_runId_idx
    ON job_run FIELDS runId UNIQUE;
DEFINE INDEX IF NOT EXISTS job_run_type_started_idx
    ON job_run FIELDS jobType, startedAt;
DEFINE INDEX IF NOT EXISTS job_run_status_idx
    ON job_run FIELDS status;
