-- 0038_reap_zombies — atomic, set-based zombie-lease reclamation.
--
-- reapZombies() used to SELECT expired 'running' rows and then loop in TS,
-- issuing one UPDATE per row. Two problems:
--   1. Two LeaseManager crons (or two pods) could each SELECT the same
--      expired row before either UPDATE landed, then both rewrite it — a
--      requeue racing an abandon, or a stale worker's late completion
--      racing the reaper. The per-row UPDATEs had no "still expired" guard.
--   2. N round-trips per tick.
--
-- fn::reap_zombies does the whole reclamation in two set-based UPDATEs
-- inside one statement. Each UPDATE re-checks `status = 'running' AND
-- leaseUntil < now` via the pre-selected id set, so a row another reaper
-- already flipped is simply not in this call's set (or matches zero rows) —
-- no double-write. Per-row exponential backoff is computed from the row's
-- own `attempts` field directly in SET, so no TS loop is needed; the count
-- of affected rows is returned via array::len.
--
-- Behaviour parity with the old TS:
--   * attempts < max_attempts  → requeue: status='pending', lease cleared,
--     visibleAfter = now + min(base * 2^(attempts-1) * jitter, 1h),
--     jitter = 0.5..1.0 (rand::float), error.name='ZombieReclaim'.
--   * attempts >= max_attempts → abandon: status='failed', finishedAt set,
--     error.name='ZombieAbandoned'.
--   * LIMIT 200 per call preserved to bound work per cron tick.

DEFINE FUNCTION OVERWRITE fn::reap_zombies($max_attempts: int, $backoff_base_ms: int) {
    LET $now = time::now();

    LET $rq_ids = (SELECT VALUE id FROM job_run
        WHERE status = 'running' AND leaseUntil < $now AND (attempts ?? 1) < $max_attempts
        LIMIT 200);
    LET $fl_ids = (SELECT VALUE id FROM job_run
        WHERE status = 'running' AND leaseUntil < $now AND (attempts ?? 1) >= $max_attempts
        LIMIT 200);

    LET $rq = UPDATE $rq_ids SET
        status = 'pending',
        claimedBy = NONE,
        leaseUntil = NONE,
        visibleAfter = time::now() + duration::from::millis(<int> math::floor(math::min([
            $backoff_base_ms * math::pow(2, (attempts ?? 1) - 1) * (0.5 + rand::float() * 0.5),
            3600000
        ]))),
        error = {
            message: 'lease expired while held by ' + (claimedBy ?? 'unknown')
                + '; requeued (attempt ' + <string>(attempts ?? 1) + '/' + <string>$max_attempts + ')',
            name: 'ZombieReclaim'
        }
        RETURN id;

    LET $fl = UPDATE $fl_ids SET
        status = 'failed',
        finishedAt = time::now(),
        claimedBy = NONE,
        leaseUntil = NONE,
        error = {
            message: 'lease expired while held by ' + (claimedBy ?? 'unknown')
                + '; abandoned after ' + <string>(attempts ?? 1) + ' attempt(s)',
            name: 'ZombieAbandoned'
        }
        RETURN id;

    RETURN { requeued: array::len($rq), failed: array::len($fl) };
};
