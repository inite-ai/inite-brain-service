-- 0029_leader_lease — global leader-election table.
--
-- Phase J replaces the process-local InFlightGuard with a
-- DistributedLeaseGuard that uses CAS against this table. Lives in
-- the system database (see SurrealService.withAdminDb), distinct from
-- per-tenant `co_*` databases. That separation matters because:
--   - leases are global (one leader for `dreams_cron` across the fleet)
--   - tenant deletion must not nuke the leader-election state
--   - operator-only — no PII, no GDPR forget interaction
--
-- Pattern: each named lease is a single record_id `leader_lease:[name]`.
-- An aspiring leader runs (inside a single multi-statement
-- BEGIN/COMMIT, so SurrealDB's SSI catches racing pods):
--
--   IF leaseUntil IS NONE OR leaseUntil < time::now() THEN
--     UPSERT leader_lease:[$name] CONTENT {
--       leaseUntil = time::now() + duration::from::secs($ttl),
--       leaderId   = $me,
--       heartbeatAt = time::now()
--     };
--   END;
--
-- Under OCC the loser tx aborts with a read-or-write-conflict —
-- retryOnUniqueViolation in the calling code catches it and the next
-- attempt re-reads the now-held lease and gives up gracefully.

DEFINE TABLE IF NOT EXISTS leader_lease SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON leader_lease TYPE string;
-- Logical lease key — 'dreams_cron' | 'compaction_cron' |
-- 'calibration_refit_cron' | 'changefeed_consumer' | 'worker_loop'.
DEFINE FIELD IF NOT EXISTS leaderId ON leader_lease TYPE string;
-- Pod / process identifier — hostname + pid by convention. Surfaces
-- in /admin/maintenance so operators see who holds what.
DEFINE FIELD IF NOT EXISTS leaseUntil ON leader_lease TYPE datetime;
DEFINE FIELD IF NOT EXISTS heartbeatAt ON leader_lease TYPE datetime
    DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS acquiredAt ON leader_lease TYPE datetime
    DEFAULT time::now();
-- Optional: human-readable note about WHY a manual takeover happened.
-- LeaseManagerService leaves it untouched; only an admin endpoint sets it.
DEFINE FIELD IF NOT EXISTS note ON leader_lease TYPE option<string>;

DEFINE INDEX IF NOT EXISTS leader_lease_name_idx
    ON leader_lease FIELDS name UNIQUE;
