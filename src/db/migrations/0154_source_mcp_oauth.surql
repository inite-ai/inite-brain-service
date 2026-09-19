-- 0154_source_mcp_oauth — the brain as an OAuth client of ANY MCP server
-- (docs/roadmap/crm-sources-2026-09.md § 4.5, W4.3; docs/source-plane.md
-- § MCP client OAuth). The static providers (Google, HubSpot, …) are
-- platform code with the operator's app in env; a hosted MCP server is
-- discovered at run time — RFC 9728 protected-resource metadata from
-- its 401, the authorization server's RFC 8414 metadata, a client
-- registered dynamically (RFC 7591) — so what the deployment learned
-- about that server has to be kept:
--
--   * source_oauth_client — one row per resource (the MCP server URL as
--     the operator named it) in the tenant namespace: the authorization
--     server's endpoints and the client the brain registered there (or
--     the operator pasted). `clientSecret` is encrypted at rest
--     (SOURCE_CREDENTIAL_ENCRYPTION_KEY, `enc:v1:…`) like every secret.
--   * source_oauth_state.resource / source_oauth_grant.resource — which
--     server a started authorization / a grant is for; the grant's
--     refresh and revocation go through the client row of that resource.
-- Additive; option-typed; no data migration.
DEFINE TABLE IF NOT EXISTS source_oauth_client SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS resource ON source_oauth_client TYPE string;
DEFINE FIELD IF NOT EXISTS origin ON source_oauth_client TYPE string;
DEFINE FIELD IF NOT EXISTS issuer ON source_oauth_client TYPE string;
DEFINE FIELD IF NOT EXISTS authorizationEndpoint ON source_oauth_client TYPE string;
DEFINE FIELD IF NOT EXISTS tokenEndpoint ON source_oauth_client TYPE string;
DEFINE FIELD IF NOT EXISTS registrationEndpoint ON source_oauth_client TYPE option<string>;
DEFINE FIELD IF NOT EXISTS revocationEndpoint ON source_oauth_client TYPE option<string>;
DEFINE FIELD IF NOT EXISTS clientId ON source_oauth_client TYPE string;
-- Encrypted; absent for a public client (PKCE alone).
DEFINE FIELD IF NOT EXISTS clientSecret ON source_oauth_client TYPE option<string>;
-- How the client authenticates at the token endpoint: none (public), body, basic.
DEFINE FIELD IF NOT EXISTS tokenAuth ON source_oauth_client TYPE string DEFAULT 'none'
  ASSERT $value IN ['none', 'body', 'basic'];
-- The scopes the resource says it takes (RFC 9728 scopes_supported).
DEFINE FIELD IF NOT EXISTS scopes ON source_oauth_client TYPE array<string> DEFAULT [];
-- 'dynamic' (RFC 7591) or 'operator' (pasted at start).
DEFINE FIELD IF NOT EXISTS registration ON source_oauth_client TYPE string DEFAULT 'dynamic'
  ASSERT $value IN ['dynamic', 'operator'];
-- The connection's private-host opt-in the discovery ran under (the fetches keep it).
DEFINE FIELD IF NOT EXISTS allowPrivate ON source_oauth_client TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS createdAt ON source_oauth_client TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON source_oauth_client TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS source_oauth_client_resource_idx ON source_oauth_client FIELDS resource UNIQUE;

DEFINE FIELD IF NOT EXISTS resource ON source_oauth_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS resource ON source_oauth_grant TYPE option<string>;
