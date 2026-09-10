-- 0141_shared_auth_limit_state — the security state that must be shared
-- by every replica behind a load balancer, which used to live in
-- process memory: rate-limit buckets, the CAEP revocation deny-list and
-- the ABAC policy coherence counter.
--
-- WHERE IT LIVES. `throttle_bucket` and `revoked_subject` are read and
-- written only through SurrealService.withAdminDb() (database = `system`,
-- the leader_lease / tenant_registry posture): a bucket is per credential,
-- not per tenant, and a revoked subject must be denied before the tenant
-- is even known. `policy_meta` is per tenant (the co_* database) next to
-- access_policy / policy_binding. The migrator applies every file to every
-- database, so the unused copies are defined but sit empty.
--
-- ADDITIVE + OVERWRITE-safe: three new tables, every statement IF NOT
-- EXISTS, no data mutation. No indexes on purpose — every access is a
-- point read/write by record id, and the GC sweeps use the
-- SELECT-ids-then-DELETE shape rather than an index-served WHERE.

-- One row per (throttler name, tracker key); id = '<name>:<key>'.
-- `hits` counts requests in the current fixed window ending at
-- `expiresAt`; an expired window is reset in place by the next hit.
-- `blockedUntil` is set when a window overflows its limit (NestJS
-- throttler blockDuration semantics) and cleared once it has passed.
DEFINE TABLE IF NOT EXISTS throttle_bucket SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS key ON throttle_bucket TYPE string;
DEFINE FIELD IF NOT EXISTS throttler ON throttle_bucket TYPE string;
DEFINE FIELD IF NOT EXISTS hits ON throttle_bucket TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS expiresAt ON throttle_bucket TYPE datetime;
DEFINE FIELD IF NOT EXISTS blockedUntil ON throttle_bucket TYPE option<datetime>;

-- Subjects the auth-service revoked (CAEP session-revoked /
-- account-disabled / token-claims-change), written by whichever replica
-- consumed the SET from the acked SSF poll stream and read by all of
-- them. id = subject. Rows are dead weight past `expiresAt` (the max
-- access-token lifetime) — the token itself has expired by then, and the
-- deny-list pull path sweeps them.
DEFINE TABLE IF NOT EXISTS revoked_subject SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS subject ON revoked_subject TYPE string;
DEFINE FIELD IF NOT EXISTS reason ON revoked_subject TYPE option<string>;
DEFINE FIELD IF NOT EXISTS revokedAt ON revoked_subject TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS expiresAt ON revoked_subject TYPE datetime;

-- Single row `policy_meta:current` per tenant: a counter every
-- access_policy / policy_binding writer bumps, so a resolver on another
-- replica can validate its cached snapshot with one point read instead
-- of waiting out its TTL.
DEFINE TABLE IF NOT EXISTS policy_meta SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS version ON policy_meta TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt ON policy_meta TYPE datetime DEFAULT time::now();
