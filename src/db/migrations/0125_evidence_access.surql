-- 0125: evidence_access — content-free audit trail of the raw-read
-- gateway (Brain v2.1 MM-3).
--
-- WHY. Serving original bytes back out is the highest-sensitivity read
-- the platform performs; every attempt (served OR denied, stream, mint
-- and redeem alike) must leave an attributable record. The row is
-- CONTENT-FREE by construction: subject handles (asset/fragment record
-- ids as plain strings), the caller's hashed credential, the verb, and
-- the gate-ladder outcome — never bytes, labels, PII classes, or URLs.
-- A signed-URL token never lands here either (it would BE a capability).
--
-- assetId / fragmentId are STRINGS, not record links, on purpose: an
-- audit row must not dangle (or vanish via record-link cleanup) when its
-- subject row dies — erasure of the trail is an explicit GDPR decision,
-- wired into the two places an asset dies (user-forget cascade and the
-- retention/quarantine tombstone path), LET/SELECT-ids → DELETE by ids.
--
-- outcome is an open vocabulary ('ok' | 'denied_<step>' — 0048 `kind`
-- doctrine: shape-capped at the write seam, no enum ASSERT), so a new
-- ladder step never needs a migration.
--
-- RENUMBER CAVEAT (0109/0122 precedent): 0119 and 0123 are claimed by
-- sibling PRs; the migrator orders by filename and tolerates gaps —
-- 0125 stays 0125 either way; do NOT renumber on rebase.

-- ── evidence_access ───────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS evidence_access SCHEMAFULL;

-- Subject handles as strings (see header — deliberately NOT record<>).
DEFINE FIELD IF NOT EXISTS assetId ON evidence_access TYPE string;
DEFINE FIELD IF NOT EXISTS fragmentId ON evidence_access TYPE option<string>;
-- The caller's hashed credential (brainAuth.keyHash; for redeem: the
-- MINTING key's hash carried inside the verified token payload).
DEFINE FIELD IF NOT EXISTS keyHash ON evidence_access TYPE string;
DEFINE FIELD IF NOT EXISTS verb ON evidence_access TYPE string
  ASSERT $value INSIDE ['stream', 'mint', 'redeem'];
-- 'ok' or 'denied_<step>' — open vocabulary, code-capped (0048 doctrine).
DEFINE FIELD IF NOT EXISTS outcome ON evidence_access TYPE string;
DEFINE FIELD IF NOT EXISTS createdAt ON evidence_access TYPE datetime DEFAULT time::now();

-- Single-field indexes ONLY (the SurrealDB 3.2.4 compound-index
-- DELETE-planner no-op class — this table sits on the GDPR delete path;
-- the 0122 evidence_grant reasoning verbatim).
DEFINE INDEX IF NOT EXISTS evidence_access_asset_idx ON evidence_access FIELDS assetId;
DEFINE INDEX IF NOT EXISTS evidence_access_key_idx ON evidence_access FIELDS keyHash;
DEFINE INDEX IF NOT EXISTS evidence_access_created_idx ON evidence_access FIELDS createdAt;

-- NO CHANGEFEED, NO EVENT, deliberately (0122 reasoning): the row names
-- a hashed principal and a subject handle; a 30-day feed would keep a
-- GDPR-erased access trail readable after the rows die.
