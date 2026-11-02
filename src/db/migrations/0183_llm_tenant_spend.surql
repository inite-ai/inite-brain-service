-- 0183_llm_tenant_spend — the per-tenant daily model budget's shared
-- counter (#853, ai/tenant-llm-budget.ts).
--
-- WHERE IT LIVES. Read and written only through SurrealService.withAdminDb()
-- (database = `system`), the throttle_bucket posture (0141): a budget is
-- enforced across replicas, and each replica flushes what it spent once a
-- minute (TenantSpendFlushService) and reads the shared total back. The
-- migrator applies every file to every database, so the tenant copies are
-- defined but sit empty.
--
-- One row per (tenant, UTC day); id = '<companyId>:<YYYY-MM-DD>'. `tokens`
-- is input + output tokens of chat calls charged to the tenant that day.
-- Rows older than a few days are dead weight and are swept by the flusher
-- with the SELECT-ids-then-DELETE shape.
--
-- ADDITIVE: one new table, every statement IF NOT EXISTS, no data mutation,
-- no index (every access is a point read/write by record id; the sweep
-- filters on `day`, a handful of rows per tenant).
DEFINE TABLE IF NOT EXISTS llm_tenant_spend SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS companyId ON llm_tenant_spend TYPE string;
DEFINE FIELD IF NOT EXISTS day ON llm_tenant_spend TYPE string;
DEFINE FIELD IF NOT EXISTS tokens ON llm_tenant_spend TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updatedAt ON llm_tenant_spend TYPE datetime DEFAULT time::now();
