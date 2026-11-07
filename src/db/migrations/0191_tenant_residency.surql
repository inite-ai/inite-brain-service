-- 0191_tenant_residency — which region each tenant's memory lives in
-- (#916 step 3, src/db/residency.ts).
--
-- A directory of company ids → region, read in the deployment's SYSTEM
-- database before a tenant database is created or opened: a deployment
-- serves only the tenants of its own region (BRAIN_REGION), refuses the
-- others with 421 and their region, and a regional cell refuses a tenant
-- it was never told about. No personal data: ids and region names only.
--
-- Like every table, it is defined in every database the migrator touches;
-- only the system database's copy is read. A pin is set by a platform
-- admin (PUT /v1/admin/tenants/:companyId/residency) and is never moved
-- silently: pinning a tenant that already has data here to another region
-- is refused — moving a tenant is an explicit export/import, not a flag.
--
-- Idempotent: IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS tenant_residency SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS companyId ON tenant_residency TYPE string;
DEFINE FIELD IF NOT EXISTS region ON tenant_residency TYPE string
  ASSERT $value = /^[a-z][a-z0-9-]{0,31}$/;
DEFINE FIELD IF NOT EXISTS assignedAt ON tenant_residency TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS assignedBy ON tenant_residency TYPE option<string>;
DEFINE INDEX IF NOT EXISTS tenant_residency_uq ON tenant_residency FIELDS companyId UNIQUE;
