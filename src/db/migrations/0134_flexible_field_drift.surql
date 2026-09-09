-- Re-assert FLEXIBLE on job_run's four object fields, because IF NOT EXISTS
-- never corrected them on tenants that already had the fields.
--
-- SYMPTOM (production, 2026-09-09): fn::reap_zombies failed on every sweep,
-- once per 10s, with
--
--     Found field 'error.message', but no such field exists for table 'job_run'
--
-- so no zombie job was ever requeued or failed out — a worker that died left
-- its row 'running' forever. 197 of the last 200 log lines were this while
-- /health stayed green, because JobClaimService.reapZombies catches, logs a
-- warn and returns {requeued: 0, failed: 0}: a total failure that reads
-- exactly like a clean sweep with nothing to do. That swallow is addressed in
-- the same change as this migration.
--
-- CAUSE. Commit 38eca44 (SurrealDB 2.3.10 -> 3.1.5) moved the clause from the
-- 2.x spelling `FLEXIBLE TYPE option<object>` to the 3.x
-- `TYPE option<object> FLEXIBLE`, across ~24 fields. All of them are declared
-- IF NOT EXISTS, which does not update an existing definition — it skips. A
-- tenant provisioned before the upgrade therefore keeps whatever the server
-- stored then, and a SCHEMAFULL table without FLEXIBLE rejects any subfield
-- the schema does not name. Fresh tenants are unaffected, which is why the
-- jobs e2e suite (test:e2e:jobs, real Surreal, covers the zombie reap) has
-- been green throughout: it always builds the schema from scratch.
--
-- This is the same class as 0105, where 0002's CHANGEFEED clause was likewise
-- dropped on tenants whose tables already existed. IF NOT EXISTS is a
-- creation guard, never a reconciliation: any clause added to — or respelled
-- in — a table after its first release needs an OVERWRITE pass like this one.
--
-- WHY OVERWRITE IS SAFE. Each statement restates the field's current intended
-- definition verbatim from 0025 — same type, same optionality, no default, no
-- permissions clause. On a tenant already holding the correct definition it is
-- a no-op rewrite; on a drifted one it repairs the clause. No data is written
-- and no row is touched.
--
-- SCOPE — job_run only, deliberately. The other ~20 respelled fields are in
-- the same class and may be drifted too, but repairing them means restating
-- each definition by hand, and a first attempt at exactly that got several
-- wrong (debug_trace.spans is `TYPE array DEFAULT []` with no FLEXIBLE at
-- all — "repairing" it would have silently changed its semantics). A blind
-- OVERWRITE sweep is a schema change wearing a repair's clothes. The right
-- follow-up is a reconciliation that derives each definition from the
-- migration that owns it and diffs it against INFO FOR TABLE, rather than a
-- human retyping twenty declarations; tracked separately.

DEFINE FIELD OVERWRITE progress ON job_run TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE result ON job_run TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE error ON job_run TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE payload ON job_run TYPE option<object> FLEXIBLE;
