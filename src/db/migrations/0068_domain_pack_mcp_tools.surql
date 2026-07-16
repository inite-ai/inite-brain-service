-- 0068_domain_pack_mcp_tools — per-install identity + consent for pack-declared
-- MCP tools. installId is the opaque id sent to external tool endpoints
-- (never companyId). Consent is stored with a checksum of the mcpTools
-- section so an upgrade that changes the section requires re-consent.
DEFINE FIELD IF NOT EXISTS installId ON domain_pack TYPE option<string>;
DEFINE FIELD IF NOT EXISTS acceptedMcpTools ON domain_pack TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS acceptedMcpToolsChecksum ON domain_pack TYPE option<string>;
