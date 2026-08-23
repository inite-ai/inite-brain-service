-- 0091: answer_cache — fact-lifecycle-gated answer reuse (G1 of
-- docs/roadmap/sota-gap-build-2026-08.md).
--
-- One row per (companyId, queryHash): a verified grounded answer keyed
-- by the EXACT normalized query + everything that could change it
-- (tenant, user scope, resolved retrieval profile + synthesize knobs,
-- model, prompt version, derived-world read pin). No embedding lookup
-- in v1 — similarity-keyed serving is unsafe for a strict-accuracy
-- platform (temporal/polarity query variants exceed 0.95 cosine and
-- become silent wrong answers); exact-match has zero false-hit surface
-- by construction.
--
-- Correctness backbone = check-on-read + TTL, not events: at serve
-- time the cited facts are re-read and the entry serves only while
-- EVERY cited fact is still status='active' and inside its validity
-- window. Any failure stamps invalidatedAt + invalidationCause and the
-- request falls through to fresh synthesis (which overwrites the row on
-- success). A lost event can never serve a dead fact because there are
-- no events on the serving path.
--
-- citedFactIds/entityIds are the provenance link the invalidation is
-- keyed on; queryText (normalized) is kept for operator inspection of
-- what a hash actually caches.

DEFINE TABLE IF NOT EXISTS answer_cache SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS companyId ON answer_cache TYPE string;
-- End-user scope of the caller the answer was built for; NONE = a
-- tenant-global (M2M) answer. A user-scoped query must never hit a
-- global entry and vice versa — the key hash separates them, and every
-- query WHERE clause double-fences on this column.
DEFINE FIELD IF NOT EXISTS userId ON answer_cache TYPE option<string>;
-- SHA256 over companyId|userId|profileHash|model|promptVersion|
-- derivedVersionPin|normalized(query); also the record id.
DEFINE FIELD IF NOT EXISTS queryHash ON answer_cache TYPE string;
DEFINE FIELD IF NOT EXISTS queryText ON answer_cache TYPE string;
DEFINE FIELD IF NOT EXISTS answer ON answer_cache TYPE string;
-- Reserved: only verdict-supported answers are admitted, which carry no
-- SynthesisReason — kept as a column so a future admission widening is
-- a data change, not a migration.
DEFINE FIELD IF NOT EXISTS reason ON answer_cache TYPE string DEFAULT '';
DEFINE FIELD IF NOT EXISTS citedFactIds ON answer_cache TYPE array<string>;
DEFINE FIELD IF NOT EXISTS entityIds ON answer_cache TYPE array<string>;
DEFINE FIELD IF NOT EXISTS profileHash ON answer_cache TYPE string;
DEFINE FIELD IF NOT EXISTS modelId ON answer_cache TYPE string;
DEFINE FIELD IF NOT EXISTS promptVersion ON answer_cache TYPE int;
DEFINE FIELD IF NOT EXISTS createdAt ON answer_cache TYPE datetime DEFAULT time::now();
-- TTL backstop (SYNTHESIZE_ANSWER_CACHE_TTL_HOURS, default 24h). An
-- expired row is a plain miss; fresh admission overwrites it in place.
DEFINE FIELD IF NOT EXISTS expiresAt ON answer_cache TYPE datetime;
DEFINE FIELD IF NOT EXISTS hitCount ON answer_cache TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS lastServedAt ON answer_cache TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS invalidatedAt ON answer_cache TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS invalidationCause ON answer_cache TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['superseded', 'retracted', 'expired_validity', 'missing'];

DEFINE INDEX IF NOT EXISTS answer_cache_company_hash_idx ON answer_cache
  FIELDS companyId, queryHash UNIQUE;
-- Sweep/inspection path: expired rows per tenant. No sweep job in v1
-- (check-on-read + TTL are the correctness backbone); the index makes
-- the future memory_diff-style sweep a range scan, not a table walk.
DEFINE INDEX IF NOT EXISTS answer_cache_company_expires_idx ON answer_cache
  FIELDS companyId, expiresAt;
