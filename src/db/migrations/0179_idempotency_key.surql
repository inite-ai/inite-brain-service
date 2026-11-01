-- 0179: idempotency_key — a write retried with the same Idempotency-Key
-- gets the first answer back instead of running twice.
--
-- WHY. A client that times out on a write cannot tell whether it landed.
-- Retrying an ingest re-ran extraction and resolution and, for writes
-- without a natural dedup key (feedback, link, retract, document
-- submissions), produced a second effect. The IETF Idempotency-Key header
-- (draft-ietf-httpapi-idempotency-key-header) is the standard answer:
-- the first request under a key stores its response, a retry with the
-- same key and the same request gets that response replayed, the same
-- key with a different request is refused (422), and a retry while the
-- first is still running is refused (409).
--
-- WHERE IT LIVES. Per tenant, like every row a request writes. Identity
-- is (scopeKey, key): scopeKey is the credential's hash, so two callers
-- choosing the same key never see each other's answers. `fingerprint`
-- hashes method, route, query and body. `body` is the stored response as
-- JSON text (a response may be an array or a scalar). `userId` is the
-- user the request acted for, so user forget erases these rows with the
-- rest of the user's data (ground rule 4).
--
-- LIFETIME. 24 hours (`expiresAt`); an expired row is ignored and
-- overwritten on the next use of its key, and a sweep deletes expired
-- rows. A 5xx is never stored: the client must be able to retry it.
--
-- ADDITIVE. New table, every statement IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS idempotency_key SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS scopeKey ON idempotency_key TYPE string;
DEFINE FIELD IF NOT EXISTS key ON idempotency_key TYPE string ASSERT string::len($value) <= 255;
DEFINE FIELD IF NOT EXISTS method ON idempotency_key TYPE string;
DEFINE FIELD IF NOT EXISTS route ON idempotency_key TYPE string;
DEFINE FIELD IF NOT EXISTS fingerprint ON idempotency_key TYPE string;
DEFINE FIELD IF NOT EXISTS state ON idempotency_key TYPE string ASSERT $value IN ['pending', 'done'];
DEFINE FIELD IF NOT EXISTS status ON idempotency_key TYPE option<int>;
DEFINE FIELD IF NOT EXISTS body ON idempotency_key TYPE option<string>;
DEFINE FIELD IF NOT EXISTS userId ON idempotency_key TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON idempotency_key TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS expiresAt ON idempotency_key TYPE datetime;

DEFINE INDEX IF NOT EXISTS idempotency_key_scope_key ON idempotency_key FIELDS scopeKey, key UNIQUE;
DEFINE INDEX IF NOT EXISTS idempotency_key_expires ON idempotency_key FIELDS expiresAt;
DEFINE INDEX IF NOT EXISTS idempotency_key_user ON idempotency_key FIELDS userId;
