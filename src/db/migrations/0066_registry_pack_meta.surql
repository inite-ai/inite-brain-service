-- 0066_registry_pack_meta — instance-local marketplace metadata for the GLOBAL
-- pack registry (registry_pack, migration 0042; lives in the `system` DB via
-- SurrealService.withAdminDb).
--
-- One row per packId (NOT per version): curation (featured) and pricing
-- (billing service integration). Deliberately OUTSIDE the signed manifest —
-- price/curation are hosting-instance decisions, not pack content, so they
-- must not invalidate signatures or checksums. The pull-only registry mirror
-- only writes registry_pack, so this table is NEVER mirrored/clobbered:
-- featured/pricing state is instance-local by design.
--
-- paid/priceCode: set by the publishing company via
--   PUT /v1/admin/registry/packs/:packId/pricing (registry:publish). The
--   priceCode names an immutable price in the billing service; re-pricing
--   mints a new code. displayPrice* are a denormalized copy for discovery
--   (minor units + ISO 4217 code) — the billing service stays authoritative.
-- featured: hosting-operator curation (registry:curate), surfaced on top of
--   the catalogue listing and /registry/ui.

DEFINE TABLE IF NOT EXISTS registry_pack_meta SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS packId               ON registry_pack_meta TYPE string;
DEFINE FIELD IF NOT EXISTS featured             ON registry_pack_meta TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS featuredAt           ON registry_pack_meta TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS paid                 ON registry_pack_meta TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS priceCode            ON registry_pack_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS displayPriceAmount   ON registry_pack_meta TYPE option<int>;
DEFINE FIELD IF NOT EXISTS displayPriceCurrency ON registry_pack_meta TYPE option<string>;
-- Provenance: the companyId whose registry:publish key set the pricing.
DEFINE FIELD IF NOT EXISTS pricingSetBy         ON registry_pack_meta TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt            ON registry_pack_meta TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt            ON registry_pack_meta TYPE option<datetime>;

-- One meta row per pack — the upsert anchor.
DEFINE INDEX IF NOT EXISTS registry_pack_meta_pack_idx
  ON registry_pack_meta FIELDS packId UNIQUE;
DEFINE INDEX IF NOT EXISTS registry_pack_meta_featured_idx
  ON registry_pack_meta FIELDS featured;
