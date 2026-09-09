-- Re-assert FLEXIBLE on job_run's four object fields.
--
-- SYMPTOM (2026-09-09): fn::reap_zombies failed on every 10 s sweep with
--   Found field 'error.message', but no such field exists for table 'job_run'
-- so a worker that died left its row 'running' forever, while
-- JobClaimService.reapZombies logged a warn and reported a clean sweep (that
-- swallow is fixed in the same change).
--
-- MECHANISM (measured on the server and reproduced locally, see 0135): the
-- 2.3.10 -> 3.1.5 cut of 2026-07-15 moved every database through
-- `surreal export --v3` on 2.6.5, and that writer drops the FLEXIBLE keyword
-- from `option<object>` / `option<array<object>>` declarations while keeping
-- it on a plain `object`. Every such field whose defining migration ran
-- before the cut therefore holds `TYPE none | object` WITHOUT FLEXIBLE, the
-- ledger says the migration ran, and IF NOT EXISTS never reconciles an
-- existing definition — a SCHEMAFULL table then rejects every sub-field the
-- schema does not name. Fresh tenants (and the jobs e2e, which builds the
-- schema from scratch) never see it.
--
-- OVERWRITE restates each definition verbatim (type, optionality, no
-- default, no permissions): a no-op on a correct field, a repair on a
-- drifted one, no row touched. This file covers job_run only — the rest of
-- the class is reconciled by 0135, generated from the migrations that own
-- each declaration rather than retyped by hand.

DEFINE FIELD OVERWRITE progress ON job_run TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE result ON job_run TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE error ON job_run TYPE option<object> FLEXIBLE;
DEFINE FIELD OVERWRITE payload ON job_run TYPE option<object> FLEXIBLE;
