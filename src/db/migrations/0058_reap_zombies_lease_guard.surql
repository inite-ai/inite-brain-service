-- 0058_reap_zombies_lease_guard — stop reaping inline (lease-less) job runs.
--
-- Bug: on SurrealDB 3.1.5 `NONE < time::now()` evaluates to TRUE (verified
-- empirically against surrealdb/surrealdb:v3.1.5), so the 0038 guard
-- `leaseUntil < $now` matches rows that have NO lease at all. Inline job_run
-- rows — created by JobRunService.start() for manually-triggered runs
-- (dreams, reindex_embeddings, calibration refits) — carry no leaseUntil,
-- so any inline run living longer than one 10s reaper tick was flipped back
-- to 'pending' with error.name='ZombieReclaim'. For job types with a
-- registered worker handler that meant a DUPLICATE execution claimed by a
-- worker while the inline run was still going (double LLM spend, graph write
-- races); for unregistered types it produced phantom zombie metrics.
--
-- Fix: require an actual lease before treating a row as a zombie —
-- `leaseUntil IS NOT NONE` added to the pre-select and BOTH update guards
-- (the guards must stay byte-equal to the pre-select so a row flipped by a
-- racing reaper between SELECT and UPDATE remains a clean no-op, per 0038).
-- Everything else is byte-identical to 0038.

DEFINE FUNCTION OVERWRITE fn::reap_zombies($max_attempts: int, $backoff_base_ms: int) {
    LET $now = time::now();

    -- One 200-row budget across both branches, matching the old single
    -- `SELECT ... LIMIT 200`. The requeue/abandon split happens in the UPDATE
    -- guards below, not by widening the cap to 200-per-branch.
    LET $ids = (SELECT VALUE id FROM job_run
        WHERE status = 'running' AND leaseUntil IS NOT NONE AND leaseUntil < $now
        LIMIT 200);

    LET $rq = UPDATE $ids SET
        status = 'pending',
        claimedBy = NONE,
        leaseUntil = NONE,
        visibleAfter = time::now() + duration::from_millis(<int> math::floor(math::min([
            $backoff_base_ms * math::pow(2, (attempts ?? 1) - 1) * (0.5 + rand::float() * 0.5),
            3600000
        ]))),
        error = {
            message: 'lease expired while held by ' + (claimedBy ?? 'unknown')
                + '; requeued (attempt ' + <string>(attempts ?? 1) + '/' + <string>$max_attempts + ')',
            name: 'ZombieReclaim'
        }
        WHERE status = 'running' AND leaseUntil IS NOT NONE AND leaseUntil < $now
            AND (attempts ?? 1) < $max_attempts
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
        WHERE status = 'running' AND leaseUntil IS NOT NONE AND leaseUntil < $now
            AND (attempts ?? 1) >= $max_attempts
        RETURN id;

    RETURN { requeued: array::len($rq), failed: array::len($fl) };
};
