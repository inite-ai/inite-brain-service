-- 0064_registry_pack_origin — provenance marker for mirrored catalogue rows
-- (registry_pack, migrations 0042 + 0063).
--
-- origin: the upstream registry base URL this version was pulled from by the
--   pull-only mirror job (RegistryMirrorService, REGISTRY_UPSTREAM_URL).
--   NONE = locally published. The mirror uses it as a one-way yank fence:
--   an upstream yank is mirrored ONLY onto rows whose origin matches that
--   upstream — locally published versions are never yanked by the mirror.
--   No backfill needed: every pre-existing row is by definition a local
--   publish, and option<string> already reads back NONE.

DEFINE FIELD IF NOT EXISTS origin ON registry_pack TYPE option<string>;
