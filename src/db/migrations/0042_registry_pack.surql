-- 0042_registry_pack — the GLOBAL Domain Pack registry catalogue.
--
-- Unlike domain_pack (migration 0040, per-tenant record of what's INSTALLED),
-- registry_pack is a GLOBAL, tenant-agnostic catalogue of what's PUBLISHED and
-- installable. It lives in the `system` database (SurrealService.withAdminDb),
-- alongside leader_lease / job_run — one shared store, not a per-tenant copy.
--
-- One row per (packId, version). A published version is IMMUTABLE: the row is
-- content-addressed by `checksum`, and republishing the same (packId, version)
-- with different content is rejected (see PackRegistryService.publish). A bad
-- version is YANKED (yanked=true — excluded from latest-resolution + default
-- listing) but never hard-deleted, so installs that pinned it stay reproducible.
--
-- Trust: the manifest's ed25519 signature + publisher are stored as-is. The
-- registry is a content store; cryptographic trust is verified END-TO-END at
-- install time against the installing tenant's trust store (same policy as a
-- direct install). `signed` is a convenience flag for discovery/filtering.

DEFINE TABLE IF NOT EXISTS registry_pack SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS packId      ON registry_pack TYPE string;
DEFINE FIELD IF NOT EXISTS version     ON registry_pack TYPE string;
DEFINE FIELD IF NOT EXISTS manifest    ON registry_pack TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS checksum    ON registry_pack TYPE string;
DEFINE FIELD IF NOT EXISTS description ON registry_pack TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS keywords    ON registry_pack TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS keywords[*] ON registry_pack TYPE string;
DEFINE FIELD IF NOT EXISTS publisher   ON registry_pack TYPE option<string>;
DEFINE FIELD IF NOT EXISTS signed      ON registry_pack TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS yanked      ON registry_pack TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS yankReason  ON registry_pack TYPE option<string>;
-- Provenance: the companyId whose admin key published this version.
DEFINE FIELD IF NOT EXISTS publishedBy ON registry_pack TYPE option<string>;
DEFINE FIELD IF NOT EXISTS publishedAt ON registry_pack TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt   ON registry_pack TYPE option<datetime>;

-- A (packId, version) is unique — the immutability anchor.
DEFINE INDEX IF NOT EXISTS registry_pack_id_version_idx
  ON registry_pack FIELDS packId, version UNIQUE;
DEFINE INDEX IF NOT EXISTS registry_pack_id_idx ON registry_pack FIELDS packId;
DEFINE INDEX IF NOT EXISTS registry_pack_yanked_idx ON registry_pack FIELDS yanked;
