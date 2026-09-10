-- 0142: tenant_registry.displayName — a workspace has a name.
--
-- WHY. A tenant arrives as `co_u_9f2c…` (personal workspace provisioned
-- on first OAuth) or as whatever identifier an operator chose, and that
-- string is what every surface had to show. An agent that just connected
-- cannot tell the user which workspace it is writing to in any way the
-- user recognises, and the first thing anyone wants to do after
-- connecting — call it something — had nowhere to be stored.
--
-- WHERE IT LIVES. On the NAMESPACE-level tenant_registry row (0104),
-- read/written through SurrealService.withAdminDb(). Same reasoning as
-- the rest of that table: the roster is tenant-agnostic and one place
-- answers for every tenant.
--
-- NOT the auth-service's organisation name. That one is the identity
-- provider's record of the org across every INITE product; this is what
-- the memory workspace calls itself. They can differ, and a rename here
-- must not reach into another product's tenant.
--
-- ADDITIVE. One optional field, IF NOT EXISTS, no data mutation. With it
-- unset every surface behaves exactly as before — the companyId is the
-- display value.

DEFINE FIELD IF NOT EXISTS displayName ON tenant_registry TYPE option<string>
    ASSERT $value = NONE OR (string::len($value) > 0 AND string::len($value) <= 80);
