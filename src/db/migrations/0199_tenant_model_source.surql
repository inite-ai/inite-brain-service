-- 0199: tenant_registry model source — who pays for a tenant's server-side
-- chat calls (#945 phase 2).
--
-- WHY. Server-side models cost the operator money, and only a paid plan
-- includes them (MODEL_PLATFORM_ENTITLEMENTS, default plan:pro,plan:team).
-- A request carries the plan on its verified credential (`entitlements`
-- claim), but background passes (dreams, the entity judge, extraction,
-- readers) have no request. Billing records the plan per user in another
-- service; Brain kept nothing per tenant. So every verified user
-- credential's entitlements are remembered here, and background work reads
-- the same answer the last request did.
--
-- FIELDS.
--   modelEntitlements    last seen `entitlements` of a verified user
--                        credential for this tenant (NONE = never seen,
--                        which resolves as a free plan).
--   modelEntitlementsAt  when they were last written (only on change).
--   modelSource          'auto' (platform when the plan includes it),
--                        'harness' (the tenant's choice: its connected agent
--                        does the reading) or 'platform' (the operator's
--                        override: platform models whatever the plan, for
--                        server-to-server tenants with no agent). NONE
--                        reads as 'auto'.
--
-- WHERE. The NAMESPACE-level tenant_registry row (0104), through
-- SurrealService.withAdminDb(), like displayName (0145).
--
-- ADDITIVE. Optional fields, IF NOT EXISTS, no data mutation, no backfill:
-- a tenant fills on its next verified user request.

DEFINE FIELD IF NOT EXISTS modelEntitlements ON tenant_registry TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS modelEntitlementsAt ON tenant_registry TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS modelSource ON tenant_registry TYPE option<string>
    ASSERT $value = NONE OR $value IN ['auto', 'harness', 'platform'];
