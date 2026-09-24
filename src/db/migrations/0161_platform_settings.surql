-- 0161: platform_setting — the operator's configuration, kept where the
-- operator can reach it.
--
-- WHY. Every knob this service has is an environment variable baked into
-- deploy-brain.yml, and the admin panel could only LOOK at them
-- (GET /v1/admin/config, read-only). So "configure brain" meant "open the
-- repository, edit a workflow, push, wait for a deploy" — and for the
-- things only an operator can know (the OAuth app registered at Google,
-- the model a tenant wants, a limit raised for one afternoon) that is not
-- configuration, it is a release. The connected-accounts surface made it
-- acute: SOURCE_OAUTH_<PROVIDER>_CLIENT_ID / _CLIENT_SECRET cannot live in
-- a public repository at all, so the feature was unreachable by design.
--
-- WHAT THIS IS. One row per overridden key. The value is applied over
-- `process.env` before NestJS boots (src/main.ts, next to applyProcessRole)
-- so EVERY existing reader — call-time `process.env.X`, `config.get('X')`
-- captured in a constructor, the env validator — sees it without a single
-- call site changing. The environment stays the floor: a key with no row
-- here reads exactly what the deploy set, and an unreadable store fails
-- open to the deploy's own values.
--
-- WHERE IT LIVES. NAMESPACE-level and tenant-agnostic, like leader_lease
-- (0029) and tenant_registry (0104): read and written only through
-- SurrealService.withAdminDb() (database = `system`). The migrator applies
-- every numbered file to every database, so the per-tenant copies are
-- defined and sit unused.
--
-- SECRETS. `secret: true` rows hold AES-256-GCM ciphertext
-- (src/common/secret-cipher.ts, `enc:v1:<kid>:…`) under
-- SOURCE_CREDENTIAL_ENCRYPTION_KEY, which is itself env-only for exactly
-- this reason — the key that unlocks the store cannot live in it. A secret
-- is never read back out of the API: the panel writes and clears, and sees
-- only whether a value is set.
--
-- ADDITIVE + OVERWRITE-safe. A new table, its fields and one index, every
-- statement IF NOT EXISTS, no data mutation anywhere. With the table empty
-- the service is byte-identical to the deploy it booted from.

DEFINE TABLE IF NOT EXISTS platform_setting SCHEMAFULL;

-- The environment variable's name, UPPER_SNAKE. Also the record id
-- (type::record('platform_setting', key)) so a write is a point-idempotent
-- UPSERT; the UNIQUE index guards a stray second row.
DEFINE FIELD IF NOT EXISTS key ON platform_setting TYPE string
    ASSERT $value != '' AND string::len($value) <= 128;
-- The override. Plain text, or `enc:v1:…` ciphertext when `secret`.
DEFINE FIELD IF NOT EXISTS value ON platform_setting TYPE string
    ASSERT string::len($value) <= 8192;
-- Whether `value` is ciphertext and must never leave the service. Stamped
-- from the catalogue at write time, not trusted from the caller.
DEFINE FIELD IF NOT EXISTS secret ON platform_setting TYPE bool DEFAULT false;
-- Who set it and when — the panel shows both, and `operator_action` holds
-- the full request audit.
DEFINE FIELD IF NOT EXISTS updatedBy ON platform_setting TYPE string DEFAULT 'unknown';
DEFINE FIELD IF NOT EXISTS updatedAt ON platform_setting TYPE datetime DEFAULT time::now();
-- The operator's own reason, when they gave one.
DEFINE FIELD IF NOT EXISTS note ON platform_setting TYPE option<string>;

DEFINE INDEX IF NOT EXISTS platform_setting_key_idx ON platform_setting
    FIELDS key UNIQUE;
