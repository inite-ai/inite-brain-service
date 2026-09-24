-- 0161_membership_plane — G6 steps 3–5 with a real membership source
-- (docs/roadmap/raw-evidence-sources-2026-09.md § 5.7, W5).
--
-- G6 step 1 gave every scoped row a `scope` array and reserved the
-- `team:` / `org:` namespaces; step 2 gave the read side an evaluator
-- behind SCOPE_TAGS_ENABLED. Neither had a WRITER: nothing in the
-- engine could say who, other than one user, may see a row. The source
-- plane now can — an org connection reads a system that already knows
-- its own groups — so this migration lands the three tables the design
-- named and nothing more:
--
--   * external_identity — the account a source knows (a GitLab member,
--     a Slack user) and, once someone links it, the brain user it IS.
--     Unlinked by default: an identity nobody has linked grants NO
--     visibility, because the alternative (guess by name) is how ACL
--     systems leak.
--   * external_principal — Zanzibar-style relation tuples: subject
--     `member` object, where the object is a `team:<connection>:<group>`
--     tag and the subject is either a brain user tag or another group
--     (nesting). Revocation is a timestamp, never a delete: a bitemporal
--     store must be able to say when someone STOPPED being a member.
--   * scope_epoch — one row, one counter. The new-enemy problem: a
--     membership change must invalidate every cached expansion of it.
--     Every write here bumps the epoch, and every cache keys on it.
--
-- No index on (subject, relation, object) beyond the UNIQUE fence, and
-- every mutation pre-selects ids (LET → UPDATE), never UPDATE … WHERE
-- on the compound (the 3.2.4 planner gotcha, PR #372 class).

-- ── external_identity ────────────────────────────────────────────────────
DEFINE TABLE IF NOT EXISTS external_identity SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS connectionId ON external_identity TYPE string;
-- The source's own id for the account (a GitLab user id, a Slack U…).
DEFINE FIELD IF NOT EXISTS externalId ON external_identity TYPE string;
DEFINE FIELD IF NOT EXISTS handle ON external_identity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS displayName ON external_identity TYPE option<string>;
-- What the source says the account's address is; the only thing an
-- automatic link may ever match on, and only against an address another
-- identity is ALREADY linked by.
DEFINE FIELD IF NOT EXISTS email ON external_identity TYPE option<string>;
-- Set = this account is that brain user. NONE = nobody has said.
DEFINE FIELD IF NOT EXISTS userId ON external_identity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS linkedAt ON external_identity TYPE option<datetime>;
-- 'operator' (an admin said so) | 'email' (matched a linked address).
DEFINE FIELD IF NOT EXISTS linkedBy ON external_identity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS firstSeenAt ON external_identity TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS lastSeenAt ON external_identity TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS external_identity_pair_idx ON external_identity
  FIELDS connectionId, externalId UNIQUE;
DEFINE INDEX IF NOT EXISTS external_identity_user_idx ON external_identity FIELDS userId;
DEFINE INDEX IF NOT EXISTS external_identity_email_idx ON external_identity FIELDS email;
DEFINE INDEX IF NOT EXISTS external_identity_conn_idx ON external_identity FIELDS connectionId;

-- ── external_principal (the tuples) ──────────────────────────────────────
DEFINE TABLE IF NOT EXISTS external_principal SCHEMAFULL;
-- 'user:<brain userId>' or a nested 'team:<connection>:<group>'.
DEFINE FIELD IF NOT EXISTS subject ON external_principal TYPE string;
DEFINE FIELD IF NOT EXISTS relation ON external_principal TYPE string DEFAULT 'member'
  ASSERT $value IN ['member'];
-- The group tag: 'team:<connectionId>:<group>'.
DEFINE FIELD IF NOT EXISTS object ON external_principal TYPE string;
DEFINE FIELD IF NOT EXISTS connectionId ON external_principal TYPE string;
-- 'connector' (a sync wrote it) | 'operator' (an admin did).
DEFINE FIELD IF NOT EXISTS source ON external_principal TYPE string DEFAULT 'connector';
DEFINE FIELD IF NOT EXISTS recordedAt ON external_principal TYPE datetime DEFAULT time::now();
-- Set = the membership ended then. The row stays: a bitemporal store
-- must be able to answer "was she a member in March?".
DEFINE FIELD IF NOT EXISTS revokedAt ON external_principal TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS external_principal_tuple_idx ON external_principal
  FIELDS subject, relation, object UNIQUE;
DEFINE INDEX IF NOT EXISTS external_principal_subject_idx ON external_principal FIELDS subject;
DEFINE INDEX IF NOT EXISTS external_principal_object_idx ON external_principal FIELDS object;
DEFINE INDEX IF NOT EXISTS external_principal_conn_idx ON external_principal FIELDS connectionId;

-- ── scope_epoch (the consistency token) ──────────────────────────────────
DEFINE TABLE IF NOT EXISTS scope_epoch SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS epoch ON scope_epoch TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS changedAt ON scope_epoch TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS reason ON scope_epoch TYPE option<string>;

-- ── the ACL a catalogue row carries ──────────────────────────────────────
-- W0 stored `acl` as an opaque object; the engine now reads one key from
-- it (`groups`), so the shape is named here for the reader.
-- (No schema change: source_item.acl is already option<object> FLEXIBLE.)
