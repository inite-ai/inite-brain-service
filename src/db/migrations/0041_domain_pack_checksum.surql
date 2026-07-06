-- 0041_domain_pack_checksum — content-integrity checksum for installed packs.
-- sha256 of the canonical (key-sorted) manifest, computed on install. Lets an
-- operator verify a distributed pack is the one they reviewed (see
-- src/ai/domain-packs/checksum.ts). Optional — pre-existing rows have none.

DEFINE FIELD IF NOT EXISTS checksum ON domain_pack TYPE option<string>;
