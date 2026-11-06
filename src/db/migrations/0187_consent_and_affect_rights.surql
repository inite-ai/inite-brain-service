-- 0187_consent_and_affect_rights — a person's consent per purpose, and
-- the inferences they contested (#909 step 3).
--
-- WHY. Consent existed only at operator install time (pack mcp /
-- modality / sources consent). Inferring how a person feels is processing
-- of special-category data when it reveals health (GDPR art. 9, LGPD art.
-- 11) and needs that PERSON's explicit consent, per purpose, recorded with
-- the notice they saw (the Replika decision, Garante 2025: no legal basis
-- mapped to each processing operation). Withdrawal must be as easy as the
-- grant and stop the processing (art. 7(3)).
--
-- consent_record: one row per grant. Revocation stamps `revokedAt` on the
-- live row (history kept: when consent held is what an audit asks); a
-- re-grant is a new row. At most one live row per (userId, purpose) —
-- enforced by the writer (ConsentService), which revokes before it grants.
--
-- affect_contest: an inference the person said is wrong. The inference
-- itself is erased; this row keeps only a hash of what was inferred, so
-- the reader (#909 step 4) never writes the same inference again — the
-- objection outlives the row it objected to without retaining its text.
--
-- Both carry userId and are erased by user forget (ground rule 4).
-- Idempotent: IF NOT EXISTS.

DEFINE TABLE IF NOT EXISTS consent_record SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON consent_record TYPE string;
DEFINE FIELD IF NOT EXISTS purpose ON consent_record TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 64;
-- GDPR art. 6(1) bases, plus art. 9(2)(a) explicit consent.
DEFINE FIELD IF NOT EXISTS basis ON consent_record TYPE string
  ASSERT $value IN ['consent', 'explicit_consent', 'contract', 'legal_obligation',
                    'vital_interests', 'public_task', 'legitimate_interests'];
-- The version of the notice the person was shown when they agreed.
DEFINE FIELD IF NOT EXISTS noticeVersion ON consent_record TYPE string
  ASSERT string::len($value) > 0 AND string::len($value) <= 128;
DEFINE FIELD IF NOT EXISTS grantedAt ON consent_record TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS revokedAt ON consent_record TYPE option<datetime>;
-- Who recorded it: the key hash or acting principal, never a secret.
DEFINE FIELD IF NOT EXISTS recordedBy ON consent_record TYPE option<string>;
DEFINE INDEX IF NOT EXISTS consent_user_idx ON consent_record FIELDS userId;

DEFINE TABLE IF NOT EXISTS affect_contest SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS userId ON affect_contest TYPE string;
-- sha256 of the normalised inferred statement.
DEFINE FIELD IF NOT EXISTS statementHash ON affect_contest TYPE string;
DEFINE FIELD IF NOT EXISTS contestedAt ON affect_contest TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS affect_contest_user_idx ON affect_contest FIELDS userId;
