-- 0104: tenant_registry — the production tenant roster (R4 finding #1).
--
-- WHY. Background fan-out jobs (compaction, retention, dreams, calibration
-- refit, reindex, changefeed drain, episode subscriptions) and the R3
-- platform-operator cross-tenant scope (resolvePlatformTenantScope) all
-- enumerate tenants through ApiKeyService.knownCompanyIds(). That method
-- reads companyIds off the in-memory BRAIN_API_KEYS table — which
-- CredentialResolverService DISABLES in production whenever a remote
-- verifier (JWKS / RFC 7662 introspection) is configured. In a normal
-- prod-JWKS config that static table is empty, so knownCompanyIds()
-- returns [] and every fan-out silently does nothing. This table gives the
-- platform a real, DB-backed roster of tenants that all callers can be
-- enumerated from regardless of the credential source.
--
-- WHERE IT LIVES. Like leader_lease (0029) and job_run, this is a
-- NAMESPACE-level, tenant-agnostic table read/written only through
-- SurrealService.withAdminDb() (database = `system`, NOT a per-tenant
-- `co_*` DB) so every tenant can be enumerated from one place. The
-- migrator applies every numbered file to every database, so the
-- tenant-side copies of this table are defined but sit unused — the
-- system-side copy is the active one (the leader_lease posture).
--
-- ADDITIVE + OVERWRITE-safe. A brand-new table plus its fields and
-- indexes, every statement IF NOT EXISTS, no data mutation on any existing
-- row in any DB. Re-runnable and idempotent. TenantRegistryService seeds
-- nothing at migrate time; the registry fills at runtime as tenants
-- authenticate (CredentialResolverService touch()) or are provisioned
-- (register()). With the registry empty, knownCompanyIds() falls back to
-- the BRAIN_API_KEYS set, so dev / single-tenant / bootstrap behaviour is
-- byte-identical to pre-0104.

DEFINE TABLE IF NOT EXISTS tenant_registry SCHEMAFULL;

-- The tenant's companyId. Also used as the record id
-- (type::record('tenant_registry', companyId)) so register()/touch() are
-- point-idempotent UPSERTs; the UNIQUE index below guards against a stray
-- second row for the same tenant.
DEFINE FIELD IF NOT EXISTS companyId ON tenant_registry TYPE string;
-- Lifecycle. `provisioning` while the schema is being applied / first
-- write is in flight; `active` once the tenant is serving; `suspended`
-- when offboarded or paused. Only `active` tenants are returned to the
-- fan-out roster.
DEFINE FIELD IF NOT EXISTS status ON tenant_registry TYPE string
    ASSERT $value INSIDE ['active', 'suspended', 'provisioning'] DEFAULT 'active';
-- Highest schema_migrations id this tenant DB has reached, when known —
-- ops visibility ("which tenants are behind?") without a per-tenant probe.
DEFINE FIELD IF NOT EXISTS schemaVersion ON tenant_registry TYPE option<string>;
-- Last time a credential for this tenant resolved (touch) or the tenant
-- was (re)registered. Drives staleness / GC decisions later; NONE until
-- the first touch.
DEFINE FIELD IF NOT EXISTS lastSeen ON tenant_registry TYPE option<datetime>;
-- Optional embedding-space id + index state the tenant is pinned to, for
-- reindex fan-out that must not cross incompatible spaces. Open/optional —
-- annotated by the provisioning path, no migration to add a value.
DEFINE FIELD IF NOT EXISTS embeddingSpace ON tenant_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS indexState ON tenant_registry TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON tenant_registry TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON tenant_registry TYPE datetime DEFAULT time::now();

-- One row per tenant. UNIQUE so a race between two register()/touch()
-- writers (or a stray CREATE) cannot fork the roster; the point-id UPSERT
-- keeps the common path a clean idempotent update.
DEFINE INDEX IF NOT EXISTS tenant_registry_company_idx ON tenant_registry
    FIELDS companyId UNIQUE;
-- listActive() filters on status — keep the active-roster read index-served.
DEFINE INDEX IF NOT EXISTS tenant_registry_status_idx ON tenant_registry
    FIELDS status;
