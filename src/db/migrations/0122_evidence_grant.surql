-- 0122: evidence_grant — ownership/access rows split out of evidence_asset
-- (Brain v2.1 MM-4).
--
-- WHY. evidence_asset_hash_idx (byteHash UNIQUE, 0109) makes the asset row
-- CONTENT IDENTITY: one row per distinct original byte stream, per tenant
-- DB. The userId column conflated OWNERSHIP into that identity — two users
-- (or a pack processor, or the system) holding the same bytes cannot be
-- represented, and user-forget had to choose between over-deletion (kill
-- shared content) and under-deletion (keep a user's bytes). The split:
--   * evidence_asset  — WHAT was observed (immutable, content-addressed);
--   * evidence_grant  — WHO may hold/serve that observation, one row per
--     (asset, owner) relationship.
-- GDPR user-forget hard-deletes the user's grant rows; the asset (rows +
-- blob, via the 0114 evidence_blob_gc outbox) dies only when NO live grant
-- remains — otherwise the content survives for its other owners, exactly
-- the 0108/#384 EXCLUSIVE-document contract applied to bytes. The legacy
-- userId column is RETAINED as provenance of the REGISTERING user (no
-- reader changes; scrubbed to NONE by forget when it names the erased
-- user and the asset survives for other owners).
--
-- BACKFILL. The FOR-loop below synthesizes one user grant per
-- legacy-owned asset, idempotent (grant-less assets only), so pre-0122
-- rows keep exactly their current owner. Prod tables are empty while
-- EVIDENCE_SUBSTRATE_ENABLED is off, so this is belt-and-braces — and the
-- forget cascade ALSO keeps a legacy `userId = $u` leg for any asset the
-- backfill never saw.
--
-- RENUMBER CAVEAT (0109 precedent): 0119-0121 are claimed by in-flight
-- sibling PRs. The migrator orders by filename and tolerates gaps — 0122
-- stays 0122 either way; do NOT renumber on rebase.

-- ── evidence_grant ────────────────────────────────────────────────────

DEFINE TABLE IF NOT EXISTS evidence_grant SCHEMAFULL;

-- Typed record link — the GDPR user-forget cascade and the retention
-- sweep both traverse grants by asset, so the target table must be known
-- to the schema (evidence_fragment.assetId precedent).
DEFINE FIELD IF NOT EXISTS assetId ON evidence_grant TYPE record<evidence_asset>;
DEFINE FIELD IF NOT EXISTS ownerKind ON evidence_grant TYPE string
  ASSERT $value INSIDE ['user', 'pack', 'system'];
-- An OWNER HANDLE (user id / pack id / 'system') — never content.
DEFINE FIELD IF NOT EXISTS ownerId ON evidence_grant TYPE string;
-- Free-form short purpose tag ('ingest', 'share', 'processor'…) —
-- open vocabulary, length-capped at the write seam (0048 `kind` doctrine).
DEFINE FIELD IF NOT EXISTS purpose ON evidence_grant TYPE option<string>;
DEFINE FIELD IF NOT EXISTS grantedAt ON evidence_grant TYPE datetime DEFAULT time::now();
-- Administrative revocation keeps the row for audit (revokeGrant); GDPR
-- user-forget HARD-DELETES the user's rows instead — a revoked grant
-- still names its owner, which is exactly what erasure must remove.
DEFINE FIELD IF NOT EXISTS revokedAt ON evidence_grant TYPE option<datetime>;

-- Single-field indexes ONLY (the SurrealDB 3.2.4 compound-index
-- DELETE-planner no-op class — this table sits on BOTH delete paths:
-- GDPR user-forget and the retention sweep). NO UNIQUE (assetId,
-- ownerKind, ownerId) natural key, despite the temptation: a compound
-- index would put assetId under the planner bug, and dedup belongs to
-- the write seam (EvidenceStoreService.addGrant) — exactly the
-- evidence_fragment locator precedent (0109).
DEFINE INDEX IF NOT EXISTS evidence_grant_asset_idx ON evidence_grant FIELDS assetId;
DEFINE INDEX IF NOT EXISTS evidence_grant_owner_idx ON evidence_grant FIELDS ownerId;
DEFINE INDEX IF NOT EXISTS evidence_grant_kind_idx ON evidence_grant FIELDS ownerKind;
DEFINE INDEX IF NOT EXISTS evidence_grant_revoked_idx ON evidence_grant FIELDS revokedAt;

-- NO CHANGEFEED, NO EVENT, deliberately (0109/0114 reasoning): a grant
-- row names a principal; a 30-day feed would keep GDPR-erased ownership
-- readable after the rows die.

-- ── GDPR tombstone counter (0080/0106/0109 idiom) ─────────────────────
-- option<int>, no DEFAULT: NONE = erased pre-0122. SCHEMAFULL
-- forgotten_entity silently drops unknown fields without this DEFINE.
DEFINE FIELD IF NOT EXISTS evidenceGrantsDeleted ON forgotten_entity TYPE option<int>;

-- ── Backfill: one synthetic user grant per legacy-owned asset ─────────
-- Idempotent: only assets with ZERO grant rows get one, so a re-applied
-- migration (or a crash-retry mid-file) never duplicates. grantedAt
-- mirrors the asset's createdAt — the ownership existed since
-- registration, not since this migration ran.
--
-- LET-then-FOR, NOT `FOR $a IN (SELECT …)`: on the pinned SurrealDB
-- 3.2.4 a FOR whose iterable is an inline SELECT subquery fails with
-- "Cannot execute statement using value: NONE" (reproduced against
-- surrealdb/surrealdb:v3.2.4, empty AND populated tables); iterating a
-- LET-bound variable works — the fn::resolve_fact `FOR $loser IN
-- $competing` idiom (0021/0022).
LET $legacyOwned = (SELECT id, userId, createdAt FROM evidence_asset WHERE userId != NONE);
FOR $a IN $legacyOwned {
  IF array::len((SELECT VALUE id FROM evidence_grant WHERE assetId = $a.id)) = 0 {
    CREATE evidence_grant CONTENT {
      assetId: $a.id,
      ownerKind: 'user',
      ownerId: $a.userId,
      purpose: 'backfill-0122',
      grantedAt: $a.createdAt
    };
  };
};
