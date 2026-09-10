-- 0141: api_key — brain-issued API keys, so a tenant can mint its own.
--
-- WHY. Until now every credential brain accepts is issued somewhere else:
-- JWTs and ik_ keys come from the auth-service, and BRAIN_API_KEYS is an
-- env table an operator edits by hand. That leaves the hosted product
-- with no self-serve path at all — the README told people to "generate a
-- key in the web app" and no such button could exist — and it leaves a
-- self-hosted deployment (which has no auth-service) editing env vars and
-- restarting to add a credential. This table is the missing store: keys
-- brain issues, verifies and revokes on its own, identically in both
-- deployments.
--
-- WHERE IT LIVES. NAMESPACE-level, tenant-agnostic, read/written only
-- through SurrealService.withAdminDb() (database = `system`), the
-- tenant_registry (0104) / leader_lease (0029) posture. It has to be:
-- resolving a bearer token means finding the key BEFORE the tenant it
-- belongs to is known, so the lookup cannot start inside a `co_*` DB.
-- The migrator applies every numbered file to every database, so the
-- tenant-side copies are defined but unused.
--
-- PLAINTEXT IS NEVER STORED. Only `sha256:<hex>` of the key, the same
-- convention ApiKeyService.hash() emits for the env table, so one
-- comparison path serves both sources. The plaintext is returned exactly
-- once, by the issuing call; `prefix` exists so a key can be recognised
-- in a list without being recoverable from it.
--
-- ADDITIVE. A new table, its fields and indexes, every statement
-- IF NOT EXISTS, no data mutation anywhere. Re-runnable and idempotent.
-- With the table empty, credential resolution behaves exactly as before:
-- the store is consulted, finds nothing, and the existing sources answer.

DEFINE TABLE IF NOT EXISTS api_key SCHEMAFULL;

-- Tenant the key authenticates as. Every read filters on it, and the
-- issuing path can only ever write the caller's own — a key that could
-- name another tenant would be a cross-tenant escalation.
DEFINE FIELD IF NOT EXISTS companyId ON api_key TYPE string;
-- SHA-256 of the plaintext, `sha256:` + 64 lowercase hex — identical to
-- the BRAIN_API_KEYS convention.
DEFINE FIELD IF NOT EXISTS keyHash ON api_key TYPE string
    ASSERT string::len($value) = 71 AND string::starts_with($value, 'sha256:');
-- Human label chosen at issue time ("laptop cursor", "ci"). Not unique:
-- people reuse names and a uniqueness error at issue time is worse than
-- two rows called "test".
DEFINE FIELD IF NOT EXISTS name ON api_key TYPE string;
-- First characters of the plaintext, for recognising a row in a list
-- ("brain_9f2c…"). Never enough to reconstruct the key.
DEFINE FIELD IF NOT EXISTS prefix ON api_key TYPE string;
-- Granted brain scopes. The issuing path narrows these to a subset of
-- what the CALLER holds, so a key can never widen its own authority.
DEFINE FIELD IF NOT EXISTS scopes ON api_key TYPE array<string>;
DEFINE FIELD IF NOT EXISTS scopes.* ON api_key TYPE string;
-- ABAC policy sets to attach, mirroring the env table's `policies`.
DEFINE FIELD IF NOT EXISTS policyNames ON api_key TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS policyNames.* ON api_key TYPE string;
-- End-user this key acts as, when it was minted from a user session.
-- Carries into ApiKeyRecord.userId, so per-user memory scoping keeps
-- working for keys as it does for tokens.
DEFINE FIELD IF NOT EXISTS userId ON api_key TYPE option<string>;
-- Who minted it (a user did, or a key id), for the audit trail.
DEFINE FIELD IF NOT EXISTS createdBy ON api_key TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON api_key TYPE datetime DEFAULT time::now();
-- Optional expiry. NONE = no expiry; resolution rejects a past value.
DEFINE FIELD IF NOT EXISTS expiresAt ON api_key TYPE option<datetime>;
-- Set on revoke. Rows are never deleted: a revoked key must stay
-- auditable, and a deleted row would let the same plaintext be minted
-- again into a hash collision-free but history-free state.
DEFINE FIELD IF NOT EXISTS revokedAt ON api_key TYPE option<datetime>;
-- Throttled "last time this key resolved" stamp — lets an operator spot
-- keys nobody uses before revoking them.
DEFINE FIELD IF NOT EXISTS lastUsedAt ON api_key TYPE option<datetime>;

-- The resolution path: hash in, at most one row out. UNIQUE both because
-- two rows for one secret is nonsense and because it makes the hot lookup
-- index-served.
DEFINE INDEX IF NOT EXISTS api_key_hash_idx ON api_key FIELDS keyHash UNIQUE;
-- Every listing is per tenant.
DEFINE INDEX IF NOT EXISTS api_key_company_idx ON api_key FIELDS companyId;
