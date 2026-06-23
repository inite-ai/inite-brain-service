-- 0030_job_run_payload — immutable handler input on enqueued rows.
--
-- Phase J part 2 adds the enqueue/claim/dispatch pattern. The handler
-- needs the original input the enqueuer wrote (which tenant, which
-- operations subset, optional dryRun flags) preserved across
-- requeue-after-failure and zombie-reclaim cycles. `progress` is the
-- wrong place — handlers overwrite it as they run, so by the time a
-- reaper picks up a zombied row the original input is gone.
--
-- This field is set once at enqueue and never modified by the worker
-- loop. SurrealDB's FLEXIBLE object lets the enqueuer ship any JSON
-- shape (a dreams payload looks different from a reindex payload);
-- the dispatcher reads it back into a typed handler-specific record.

DEFINE FIELD IF NOT EXISTS payload ON job_run TYPE option<object> FLEXIBLE;
