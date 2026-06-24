-- 0024_debug_trace — persist the in-memory trace ring buffer.
--
-- Prior state: TraceBufferService kept the last 100 snapshots in a
-- process-local array. Restart loses everything; in HA each pod has
-- its own window so a share-link copied from one pod fails on another.
--
-- This migration declares a single SCHEMAFULL table holding the same
-- shape DebugTraceSnapshot exposes to the admin UI. Spans + artifacts
-- are FLEXIBLE so the snapshot can grow new attributes without a
-- migration cascade. TTL is enforced application-side (TraceBufferService
-- prunes oldest rows past N) — SurrealDB has no built-in TTL gate yet,
-- and we don't want to set a CHANGEFEED on this audit-irrelevant table.
--
-- The table is per-tenant inside the tenant DB. The buffer-service
-- writes via `withCompany(companyId)` so a request to brain that
-- already declared a tenant naturally lands its snapshot there.

DEFINE TABLE IF NOT EXISTS debug_trace SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS requestId ON debug_trace TYPE string;
DEFINE FIELD IF NOT EXISTS ts ON debug_trace TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS method ON debug_trace TYPE string;
DEFINE FIELD IF NOT EXISTS path ON debug_trace TYPE string;
DEFINE FIELD IF NOT EXISTS status ON debug_trace TYPE int;
DEFINE FIELD IF NOT EXISTS durationMs ON debug_trace TYPE int;
DEFINE FIELD IF NOT EXISTS companyId ON debug_trace TYPE option<string>;
-- SurrealDB 3.x validates object-element sub-fields even on FLEXIBLE arrays;
-- arbitrary keys are only allowed by typing the element via `field.*` as a
-- FLEXIBLE object. The parent must be plain `array` (NOT option<array>, which
-- auto-defines `.*` and then collides). See migration audit for 2x→3x.
DEFINE FIELD IF NOT EXISTS spans ON debug_trace TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS spans.* ON debug_trace TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS artifacts ON debug_trace TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS artifacts.* ON debug_trace TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS errored ON debug_trace TYPE option<object> FLEXIBLE;

DEFINE INDEX IF NOT EXISTS debug_trace_request_idx
    ON debug_trace FIELDS requestId UNIQUE;
DEFINE INDEX IF NOT EXISTS debug_trace_ts_idx
    ON debug_trace FIELDS ts;
