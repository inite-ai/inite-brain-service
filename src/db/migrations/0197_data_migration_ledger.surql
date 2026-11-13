-- 0197_data_migration_ledger — where each data migration stands in this
-- tenant (src/db/data-migrations/).
--
-- WHY. Row backfills used to ride inside schema migrations as one
-- full-table `UPDATE … WHERE …`. On SurrealDB 3.2.4 such an UPDATE whose
-- filter is planned through an index on the field it filters is a silent
-- no-op (see 0178's header): 0182's backfill left 20 closed edges
-- unchecked across 3 production tenants, and 0164's second backfill left
-- one closed edge without validUntil, both still recorded as applied. And
-- a backfill in a schema file runs on the request path, unbatched, in the
-- one transaction the migrator opens per file.
--
-- From here on, schema migrations are DDL only. A row fix is a data
-- migration: a class registered in Nest DI that counts the rows still
-- needing it and fixes them in batches by explicit record id, run by the
-- background `data_migrations` job. This table is its per-tenant ledger:
--
--   data_migration:⟨id⟩  one row per data migration id
--     status      pending | done. `done` is written only after a re-count
--                 found no row left (verified, never assumed).
--     fixed       rows fixed so far, over every run.
--     remaining   the last count of rows still needing the fix.
--     lastRunAt   when a run last worked on it.
--     verifiedAt  when the re-count found nothing left.
--
-- No user content: ids, counts and instants only, so the GDPR forget
-- cascade has nothing to erase here.
--
-- DDL only. Idempotent: IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS data_migration SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS status ON data_migration TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'done'];
DEFINE FIELD IF NOT EXISTS fixed ON data_migration TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS remaining ON data_migration TYPE option<int>;
DEFINE FIELD IF NOT EXISTS lastRunAt ON data_migration TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS verifiedAt ON data_migration TYPE option<datetime>;
