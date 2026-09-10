-- 0142: fencing token for leader leases and the claims taken under them.
--
-- leader_lease.epoch counts fresh acquisitions of a lease name: it goes up
-- by one whenever the holder changes (or the row was missing), and is kept
-- while the same holder renews. job_run.claimEpoch records the worker_loop
-- epoch the claiming pod held when it won the row. The renew and the
-- terminal complete / fail / cancelled / release writes require the row's
-- claimEpoch to still equal the one the claim was taken under, so a pod
-- whose leadership lapsed cannot overwrite a row that was claimed again in
-- a later epoch. Both tables are SCHEMAFULL; without these definitions the
-- writes would be rejected.
DEFINE FIELD IF NOT EXISTS epoch ON leader_lease TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS claimEpoch ON job_run TYPE option<int>;
