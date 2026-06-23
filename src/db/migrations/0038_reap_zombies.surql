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
-- fn::reap_zombies does the whole reclamation as two set-based UPDATEs inside
-- one statement. Both UPDATEs carry the SAME guard the pre-select used —
-- `status = 'running' AND leaseUntil < $now` (plus the attempts split) — so a
-- row another reaper already flipped between this call's SELECT and UPDATE
-- matches zero rows and is neither rewritten nor counted. (A racing committer
-- that flips the row first also wins the per-record write check; the guard is
-- what makes the loser a clean no-op rather than relying on abort.) Per-row
-- exponential backoff is computed from the row's own `attempts` field directly
-- in SET, so no TS loop is needed; the count of affected rows is returned via
-- array::len.
--
-- Behaviour parity with the old TS:
--   * attempts < max_attempts  → requeue: status='pending', lease cleared,
--     visibleAfter = now + min(base * 2^(attempts-1) * jitter, 1h),
--     jitter = 0.5..1.0 (rand::float, evaluated per row in the SET),
--     error.name='ZombieReclaim'.
--   * attempts >= max_attempts → abandon: status='failed', finishedAt set,
--     error.name='ZombieAbandoned'.
--   * A SINGLE LIMIT 200 budget per call (one pre-select, then split by
--     attempts in the two UPDATE guards) — matches the old one-SELECT-then-
--     split-in-TS bound of 200 total rows per tick, NOT 200-per-branch.

DEFINE FUNCTION OVERWRITE fn::reap_zombies($max_attempts: int, $backoff_base_ms: int) {
    LET $now = time::now();

    -- One 200-row budget across both branches, matching the old single
    -- `SELECT ... LIMIT 200`. The requeue/abandon split happens in the UPDATE
    -- guards below, not by widening the cap to 200-per-branch.
    LET $ids = (SELECT VALUE id FROM job_run
        WHERE status = 'running' AND leaseUntil < $now
        LIMIT 200);

    LET $rq = UPDATE $ids SET
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
        WHERE status = 'running' AND leaseUntil < $now AND (attempts ?? 1) < $max_attempts
        RETURN id;

    LET $fl = UPDATE $ids SET
        status = 'failed',
        finishedAt = time::now(),
        claimedBy = NONE,
        leaseUntil = NONE,
        error = {
            message: 'lease expired while held by ' + (claimedBy ?? 'unknown')
                + '; abandoned after ' + <string>(attempts ?? 1) + ' attempt(s)',
            name: 'ZombieAbandoned'
        }
        WHERE status = 'running' AND leaseUntil < $now AND (attempts ?? 1) >= $max_attempts
        RETURN id;

    RETURN { requeued: array::len($rq), failed: array::len($fl) };
};
