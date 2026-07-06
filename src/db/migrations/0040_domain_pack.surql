-- 0040_domain_pack — per-tenant record of runtime-installed Domain Packs.
--
-- Builtin packs (BUILTIN_PACKS, e.g. code_memory) are seeded globally via
-- SEED_PREDICATES on bootstrap and are NOT recorded here. This table tracks
-- packs installed at RUNTIME per tenant (community / custom manifests) so an
-- operator can install / upgrade / uninstall an ontology without a redeploy.
-- The full manifest is stored so an upgrade can diff against the prior version
-- and an uninstall knows which predicates to deprecate.
--
-- Predicates themselves still live in knowledge_predicate (migration 0011);
-- install seeds them there. Uninstall deprecates them (status='deprecated'),
-- never hard-deletes — recorded facts on those predicates must survive.

DEFINE TABLE IF NOT EXISTS domain_pack SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS packId      ON domain_pack TYPE string;
DEFINE FIELD IF NOT EXISTS version     ON domain_pack TYPE string;
DEFINE FIELD IF NOT EXISTS manifest    ON domain_pack TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS status      ON domain_pack TYPE string DEFAULT 'active'
  ASSERT $value IN ['active', 'removed'];
DEFINE FIELD IF NOT EXISTS installedAt ON domain_pack TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt   ON domain_pack TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS domain_pack_id_idx ON domain_pack FIELDS packId UNIQUE;
DEFINE INDEX IF NOT EXISTS domain_pack_status_idx ON domain_pack FIELDS status;
