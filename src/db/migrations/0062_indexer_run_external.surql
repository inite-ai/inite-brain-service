-- 0062_indexer_run_external — external work items on the indexer_run ledger.
--
-- External indexers (indexer.mode 'external') get their work through a
-- pull API (GET /v1/indexer/work): ingest pre-creates a 'pending'
-- indexer_run per routed external pack, the remote indexer polls, claims
-- (CAS pending→running + claimToken), reads the stored content, and
-- submits candidates. The `external` discriminator exists because these
-- rows have different lifecycle rules from in-process runs:
--
--   * they NEVER defer a document's commit (countNonTerminalRuns skips
--     them) — a slow third-party poller must not hold memory hostage; a
--     late submission re-commits incrementally via the existing reconcile;
--   * 'pending' external rows are exempt from the 30-minute stale reap —
--     a daily poller is legitimate; they expire after
--     INDEXER_EXTERNAL_PENDING_TTL_DAYS (default 7) instead. Claimed
--     ('running') rows past the stale window (claim lease rides
--     createdAt, refreshed by heartbeat) are RELEASED back to 'pending'
--     — an abandoned claim must stay discoverable by the next poll.
--
-- claimToken fences submissions from a claimant that lost its lease:
-- finalize/submit with a stale token loses to the CAS, exactly like the
-- job-claim ownership guards.

DEFINE FIELD IF NOT EXISTS external   ON indexer_run TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS claimToken ON indexer_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS claimedAt  ON indexer_run TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS indexer_run_external_idx
  ON indexer_run FIELDS external, status;
