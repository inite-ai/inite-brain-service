-- 0180: the brain's MCP client follows the 2026-07-28 authorization rules.
--
-- WHY. The MCP 2026-07-28 revision tightens the client side of OAuth:
--   * RFC 9207 (SEP-2468): a client MUST check a present `iss` on the
--     authorization response against the issuer it started with, before
--     redeeming the code. An authorization server that advertises
--     `authorization_response_iss_parameter_supported` must send it, so its
--     absence is then an error too. That defeats a mix-up between two
--     authorization servers. The state row now remembers whom it started
--     with (`issuer`) and whether `iss` must come back (`issRequired`).
--   * Client ID Metadata Documents replace Dynamic Client Registration
--     (RFC 7591, now deprecated): where the authorization server supports
--     them, the brain's client_id is the HTTPS URL of a document it serves,
--     and nothing is registered. `registration` records that as
--     `metadata_document`.
--   * Credentials are bound to the authorization server that issued them
--     (SEP-2352): source_oauth_client already stores `issuer`; the code
--     re-registers when a resource's issuer changes. No schema change.
--
-- ROLLING DEPLOY. Additive: two optional fields, and one more allowed
-- value. The image rolling out from never writes it. OVERWRITE replaces only
-- the ASSERT; type and default are unchanged.

DEFINE FIELD IF NOT EXISTS issuer ON source_oauth_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS issRequired ON source_oauth_state TYPE option<bool>;

DEFINE FIELD OVERWRITE registration ON source_oauth_client TYPE string DEFAULT 'dynamic'
  ASSERT $value IN ['dynamic', 'operator', 'metadata_document'];
