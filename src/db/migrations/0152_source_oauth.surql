-- 0152_source_oauth — the brain as an OUTBOUND OAuth client
-- (docs/roadmap/raw-evidence-sources-2026-09.md W4; docs/source-plane.md
-- § Connected accounts). Two tables, both in the tenant namespace:
--
--   * source_oauth_state — one row per authorization the admin started
--     and has not finished: the PKCE verifier (encrypted), who asked,
--     which provider and scopes, where the browser goes back to. Short-
--     lived (expiresAt, 10 min); the callback deletes it.
--   * source_oauth_grant — one row per account an admin connected: the
--     provider, an account label (e-mail / login / workspace — never a
--     secret), the scopes granted and the token set. `tokens` is ONE
--     string, encrypted at rest with SOURCE_CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM,
--     `enc:v1:<kid>:…`) — the refresh token never sits in the clear.
--     A connection names its grant as `credential = 'oauth:<grant id>'`
--     and the engine resolves a fresh access token at run time.
-- Additive; option-typed; no data migration.
DEFINE TABLE IF NOT EXISTS source_oauth_state SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS nonce ON source_oauth_state TYPE string;
DEFINE FIELD IF NOT EXISTS provider ON source_oauth_state TYPE string;
DEFINE FIELD IF NOT EXISTS scopes ON source_oauth_state TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS codeVerifier ON source_oauth_state TYPE string;
DEFINE FIELD IF NOT EXISTS redirectUri ON source_oauth_state TYPE string;
-- The admin UI origin the callback page may postMessage the result to.
DEFINE FIELD IF NOT EXISTS origin ON source_oauth_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS actor ON source_oauth_state TYPE string;
DEFINE FIELD IF NOT EXISTS userId ON source_oauth_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON source_oauth_state TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS expiresAt ON source_oauth_state TYPE datetime;
DEFINE INDEX IF NOT EXISTS source_oauth_state_nonce_idx ON source_oauth_state FIELDS nonce UNIQUE;

DEFINE TABLE IF NOT EXISTS source_oauth_grant SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS provider ON source_oauth_grant TYPE string;
-- What the admin sees: the e-mail / login / workspace the account is.
DEFINE FIELD IF NOT EXISTS account ON source_oauth_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scopes ON source_oauth_grant TYPE array<string> DEFAULT [];
-- Encrypted JSON: { accessToken, refreshToken?, expiresAt?, tokenType }.
DEFINE FIELD IF NOT EXISTS tokens ON source_oauth_grant TYPE string;
DEFINE FIELD IF NOT EXISTS status ON source_oauth_grant TYPE string DEFAULT 'active'
  ASSERT $value IN ['active', 'revoked', 'broken'];
DEFINE FIELD IF NOT EXISTS actor ON source_oauth_grant TYPE string;
-- Set = the account belongs to this user (a personal connection's grant).
DEFINE FIELD IF NOT EXISTS userId ON source_oauth_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS lastRefreshAt ON source_oauth_grant TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS lastError ON source_oauth_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON source_oauth_grant TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON source_oauth_grant TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS source_oauth_grant_provider_idx ON source_oauth_grant FIELDS provider, status;
