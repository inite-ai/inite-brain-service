-- 0005_pii_permissions — DB-level PII enforcement gate.
--
-- Architecture (cf. AGENTS A1 + Pinecone-Nexus governance framing):
--
-- Until this migration, PII filtering ran exclusively in JS via
-- `policyFor(predicate).requiresScope`. That worked for the
-- typed REST surface, but a future caller talking direct SurrealQL
-- (debug tool, raw MCP, ops-team query) would bypass it. The service
-- needs a SECOND fence inside the database itself.
--
-- SurrealDB v2 PERMISSIONS clauses are evaluated for ALL non-root
-- callers. Root signin bypasses them — by design, so admin tooling
-- can still touch everything. So:
--
--   * Schema apply, GDPR forget, compaction, ops scripts
--     → use the existing root pool (`SurrealService.withCompany`).
--   * Caller-facing reads (search, profile, timeline, artifacts)
--     → use the new scoped pool signed in as `brain_caller`,
--       which has EDITOR role and is subject to PERMISSIONS.
--
-- The PERMISSIONS clause checks the SESSION variable
-- `$caller_scopes`, which is set by the service via
-- `LET $caller_scopes = $scopes` immediately after acquiring a
-- scoped connection. Per-tenant database, per-request session.
--
-- Why a session var, not $auth.scopes:
--   $auth is populated when the connection is signed in via a
--   DEFINE ACCESS JWT route. That works only when SurrealDB itself
--   verifies the caller JWT against the inite-auth JWKS. That
--   couples the brain DB to a specific issuer and forces every
--   tenant DB to carry the same DEFINE ACCESS row. The session-var
--   approach decouples: the brain service verifies the caller JWT
--   (already done in JwksService) and forwards the extracted scopes
--   to the DB session. Same governance result, looser coupling.
--
-- Trust chain:
--   caller JWT (signed by inite-auth)
--     → JwksService.verify (signature + issuer + audience)
--     → req.brainAuth.scopes
--     → withScopedCompany(scopes, fn)
--     → LET $caller_scopes = $scopes (per-request)
--     → PERMISSIONS WHERE $caller_scopes CONTAINS ...

-- ─── Scoped user (created at namespace level so it's shared across
-- all tenant databases inside the brain namespace).
DEFINE USER IF NOT EXISTS brain_caller ON NAMESPACE
    PASSWORD 'brain-caller-password-must-be-overridden-via-env'
    ROLES EDITOR;

-- ─── PII-gated field permissions on knowledge_fact.
--
-- The whole `object` field of a fact is the leak vector — its content
-- is `email: jane@x.io` or `address: 12 Main St` — so we gate THE
-- WHOLE FIELD, not just rows. A request without `brain:read_pii`
-- gets NONE for `object` on PII-classed predicates; the rest of the
-- fact (id, predicate, confidence, recordedAt) still surfaces, so
-- the caller can SEE that a PII fact exists for the entity but not
-- read its value. This matches the GDPR "right to know there's data"
-- without leaking the data.
--
-- Predicates classified `sensitive` per knowledge.yaml:
--   address, dob (and future health.* predicates)
-- Predicates classified `identifier`:
--   email, phone (also gated — they ARE direct identifiers, even
--   though knowledge.yaml leaves them piiClass=identifier with no
--   default scope; we promote them to gated for safety. Override
--   via env if a vertical needs them visible to non-PII scopes).
--
-- The two ASSERT-friendly forms:
--
--   FOR select WHERE
--     predicate NOT IN ['address','dob','email','phone']
--     OR $caller_scopes ?? [] CONTAINS 'brain:read_pii'
--
-- The `?? []` defends against $caller_scopes being NONE on a
-- connection that hasn't called LET — without it, IS NONE CONTAINS
-- raises an error and fails-closed (which is also acceptable but
-- noisier).
-- Per knowledge.yaml security_invariants:
--   "Predicates with pii_class=sensitive (address, dob, health.*) MUST
--    NOT appear in MCP search results unless caller has brain:read_pii."
-- email/phone are pii_class=identifier, NOT sensitive — they remain
-- visible for non-PII-scoped callers per spec. Verticals declaring
-- domain predicates with pii_class=sensitive can extend this gate
-- via spec PR or per-tenant policy override (future research stream).
DEFINE FIELD OVERWRITE object ON knowledge_fact TYPE string PERMISSIONS
    FOR select WHERE
        predicate NOT IN ['address', 'dob']
        OR ($caller_scopes ?? []) CONTAINS 'brain:read_pii';

-- objectMeta carries structured (non-string) PII for the same predicates
-- when callers ingest non-string objects. Same gate.
DEFINE FIELD OVERWRITE objectMeta ON knowledge_fact TYPE option<object> FLEXIBLE PERMISSIONS
    FOR select WHERE
        predicate NOT IN ['address', 'dob']
        OR ($caller_scopes ?? []) CONTAINS 'brain:read_pii';
