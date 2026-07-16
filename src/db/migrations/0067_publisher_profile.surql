-- 0067_publisher_profile — public marketplace profile per registry publisher
-- id (the key id in DOMAIN_PACK_TRUSTED_KEYS). Lives in the `system` DB next
-- to registry_pack / registry_pack_meta.
--
-- Writable only by a company that has published at least one VERIFIED pack
-- under that publisher id (checked in PublisherProfileService — the ed25519
-- signature validated against this instance's trust store is what ties a
-- companyId to a publisher name; without it anyone could squat a well-known
-- publisher's profile). Instance-local; the pull-only registry mirror never
-- writes this table.

DEFINE TABLE IF NOT EXISTS publisher_profile SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS publisher    ON publisher_profile TYPE string;
DEFINE FIELD IF NOT EXISTS displayName  ON publisher_profile TYPE string;
DEFINE FIELD IF NOT EXISTS url          ON publisher_profile TYPE option<string>;
DEFINE FIELD IF NOT EXISTS bio          ON publisher_profile TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS contactEmail ON publisher_profile TYPE option<string>;
-- Provenance: the companyId whose registry:publish key created the profile.
DEFINE FIELD IF NOT EXISTS createdBy    ON publisher_profile TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt    ON publisher_profile TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt    ON publisher_profile TYPE option<datetime>;

-- One profile per publisher id — the upsert anchor.
DEFINE INDEX IF NOT EXISTS publisher_profile_publisher_idx
  ON publisher_profile FIELDS publisher UNIQUE;
