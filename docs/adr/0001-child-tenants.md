# ADR 0001: Child tenants for B2B family products

- Status: proposed (2026-11-15)
- Owner decision: 2026-11-14, "one tenant per client company inside B2B products"
- Code: `src/auth/child-tenant.ts`, `src/auth/api-key.guard.ts`,
  `src/tenants/`, tests `test/child-tenants.unit-spec.ts`,
  `test/child-tenants.e2e-spec.ts`

## Context

inite.rent serves rental companies and inite.training serves clubs. Each of
their client companies must keep its memory in its own Brain tenant: no
search, synthesis or background pass may ever mix two client companies.

A family product talks to Brain through one auth.inite.ai machine client
(`<product>-brain`, kind machine). Brain takes a machine token's tenant
from its `sub` (the client's `companyId`), so a product reaches exactly
one tenant. Minting one auth client per client company does not scale,
and it would make the product hold hundreds of secrets.

The existing cross-tenant path (`X-Brain-Tenant` with
`brain:platform_admin` and `BRAIN_TENANT_OVERRIDE_ENABLED`) is the hosting
operator's authority over every tenant. Granting it to a product would let
inite.rent read inite.training's clients.

## Decision

1. **A new scope, `brain:tenants`**: "act for this credential's child
   tenants". It grants nothing on its own and reaches no tenant outside
   the credential's own namespace.
2. **A header names the child per request**: `X-Brain-Child-Tenant: <child>`.
   With it the request runs in the tenant `<own companyId>__<child>`.
3. **The namespace is derived, never asserted.** The parent half is
   always the verified credential's own `companyId`. So product A can
   only reach `A__*`; naming `B__x` is not a valid child id (a child id
   is `^[a-z0-9][a-z0-9-]{0,39}$`, no `_`), and the whole id must still
   fit the 64-character companyId rule.
4. **`__` is reserved.** A credential whose own `companyId` contains `__`
   is refused on every route (403). Without that, an auth client created
   with `companyId = A__x` would land in A's child without A's authority.
   Children do not nest.
5. **Only machine credentials.** A user-bound token (one with an end-user)
   cannot name a child: a product's backend acts for its client
   companies, not one person's token.
6. **Implicit creation.** A child exists from its first request: the
   tenant database is created and migrated by `ensureSchema` exactly as
   for any new tenant, and the guard notes the child in
   `tenant_registry`, so the fan-out roster (the worker's job claims,
   crons, HNSW provisioning) walks it like any tenant.
7. **Whole-child erase.** `DELETE /v1/tenants/children/:childId`, needing
   `brain:tenants`, run as the parent (without the child header), drops the child's database and removes its registry
   row. It is how a product offboards a client company. The id can be
   used again and starts empty.
8. **Everything else is unchanged inside a child.** Per-user scope
   (`userId`), user forget and its tombstone, retention, ABAC and
   throttling (the bucket stays the credential's) work in a child exactly
   as in any tenant.

## Consequences

- **Erase rides `brain:tenants`, not `brain:erase`.** `brain:erase` is
  documented and pinned (`test/brain-erase-scope.unit-spec.ts`) as "erase
  ONE end-user and nothing else". Dropping a whole client company is the
  authority over children itself, so the scope that grants children is
  the one that may remove them.

- **Token contract.** `brain:tenants` is a new scope name, which AGENTS.md
  ground rule 3 reserves for a Triad-level change. Brain accepts it from
  JWKS and introspection after this change; auth.inite.ai must allow it
  on machine clients, and inite-triad `docs/compatibility.md` must list
  it, before a product is issued one. Until then the feature is inert
  (no credential carries the scope).
- **Reserved separator.** Any existing tenant whose `companyId` contains
  `__` would be refused. None is known; the check is deliberate and
  should be confirmed against the production `tenant_registry` before
  release.
- **Cost.** One header read and a string concat per request; the first
  request of a child pays the tenant's migration once, as any new tenant
  does. Each child is a database: many small children cost Surreal
  memory and per-tenant background passes, sized like any tenant.
- **Erase is not fenced against a running writer.** If the product keeps
  writing to a child while erasing it, a later request recreates an empty
  child. Offboarding stops the product's writes first. Other replicas drop
  the child from their roster at their next registry refresh (60 s); a
  job they enqueue in that window lands in an empty database.
- **MCP.** The header works on every route behind `ApiKeyGuard`,
  including `POST /mcp`. The path-addressed `/mcp/:companyId` form is not
  extended to children.

## Alternatives considered

- **One auth client per client company.** No Brain change, but secrets
  and onboarding per company, and offboarding would mean deleting auth
  clients and dropping databases by hand.
- **The platform override for products.** Rejected: it reaches every
  tenant, not a namespace.
- **A claim naming the child, minted per company by auth.** Stronger
  (the child is signed), but needs a token per company and an auth
  change per onboarding. The header keeps one token per product; the
  derived namespace bounds what the header can reach.
