-- 0028_job_run_lease — extend job_run for distributed CAS-claim.
--
-- Phase J adds the queue-coordination fields the original migration
-- 0025 didn't have because the runtime was single-process in-memory:
--
--   - claimedBy:   pod / worker identifier that won the CAS claim.
--                   Resets to NONE on terminal status so a re-enqueue
--                   (manual retry) doesn't carry the old owner.
--   - claimedAt:   instant of CAS win. Diagnostic only — leaseUntil
--                   is the gate the reaper uses.
--   - leaseUntil:  expiry beyond which the row is treated as zombie
--                   and either reclaimed (reaper) or recycled
--                   (status flipped back to 'pending').
--   - heartbeatAt: most recent renew tick. Reaper compares against
--                   leaseUntil + grace to spot stuck workers whose
--                   loop died mid-job.
--   - attempts:    incremented on each CAS claim. Bounded retry — a
--                   job that fails three times stays as 'failed'
--                   rather than oscillating between pending/running.
--   - dedupKey:    optional idempotency key. UNIQUE — duplicate
--                   enqueue (e.g. cron firing twice during leader
--                   transition) collapses into one row.
--   - visibleAfter: scheduled-run anchor. Defaults to creation time
--                   so claim sees the row immediately; setting it
--                   forward implements delayed jobs + visibility
--                   timeout on requeue.
--
-- pending -> running -> succeeded|failed|cancelled is the canonical
-- state machine. Phase E shipped 'running' as the initial status
-- because there was no separate enqueuer. Phase J flips this: every
-- row is born 'pending', the WorkerLoopService claims it.

DEFINE FIELD IF NOT EXISTS claimedBy ON job_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS claimedAt ON job_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS leaseUntil ON job_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS heartbeatAt ON job_run TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS attempts ON job_run TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS dedupKey ON job_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS visibleAfter ON job_run TYPE datetime
    DEFAULT time::now();

-- Composite index for the CAS-claim hot path. Worker poll executes
-- `... WHERE status='pending' AND visibleAfter <= time::now() ORDER BY
-- visibleAfter ASC LIMIT 1` — the index makes that O(log N) on the
-- claim pool size rather than full-scan.
DEFINE INDEX IF NOT EXISTS job_run_claim_idx
    ON job_run FIELDS status, visibleAfter;

-- Reaper sweep — find rows whose lease expired while their worker
-- was still alive (or died). Cheap index seek over the running set.
DEFINE INDEX IF NOT EXISTS job_run_lease_idx
    ON job_run FIELDS status, leaseUntil;

-- Idempotency. Two attempts to enqueue the same (jobType, dedupKey)
-- collapse — the second CREATE throws and the caller GETs the
-- existing row. NULL dedupKey rows are exempt from the constraint
-- (the typical case — most operator-triggered jobs don't have one).
DEFINE INDEX IF NOT EXISTS job_run_dedup_idx
    ON job_run FIELDS jobType, dedupKey UNIQUE;
