-- 0063_registry_pack_downloads — download counters + verified-publisher flag
-- for the GLOBAL pack registry catalogue (registry_pack, migration 0042).
--
-- downloads: per-version counter, incremented ONLY on the install path
--   (PackRegistryService.resolveForInstall, serving POST
--   /v1/admin/packs/from-registry). Catalogue browsing and manifest
--   inspection deliberately do NOT count — the number means "installs
--   served", not "page views". The catalogue summary reports the SUM
--   across a pack's versions.
--
-- verified: set at PUBLISH time when the manifest carries an ed25519
--   signature that validates against the HOSTING instance's trust store
--   (DOMAIN_PACK_TRUSTED_KEYS). A discovery/UX signal only: install-time
--   verification against the INSTALLING tenant's own trust store
--   (assertPackTrust) remains the real security boundary.

DEFINE FIELD IF NOT EXISTS downloads ON registry_pack TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS verified  ON registry_pack TYPE bool DEFAULT false;

-- Backfill versions published before this migration: DEFAULT applies on
-- CREATE only, so pre-existing rows would read back NONE without this.
UPDATE registry_pack SET downloads = 0 WHERE downloads IS NONE;
UPDATE registry_pack SET verified = false WHERE verified IS NONE;
