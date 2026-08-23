-- 0093: scope-tag foundation — a per-row `scope` column mirroring the
-- 0055 `userId` scope, backfilled behavior-identically (G6 step 1 of
-- docs/roadmap/sota-gap-build-2026-08.md).
--
-- Generalizes the single caller-asserted `userId` (migration 0055,
-- extended to L0 by 0073/0075) into a scope-tag model that later steps
-- extend to org/team membership. A `scope` is an array of tags, each
-- `<namespace>:<id>`, interpreted as ONE AND-set clause. TAG GRAMMAR:
--   * `user:<id>` — the ONLY namespace written today; the exact
--     one-clause equivalent of a row's `userId`.
--   * `org:<id>` / `team:<id>` — RESERVED for the later steps (ABAC
--     write/widen, share-up via staging, revocation tokens). No writer
--     emits them here; the parser (src/auth/scope-tags.ts) accepts them
--     so those steps are a data change, not a migration.
--
-- Empty scope (`[]`) is tenant-global — the `userId IS NONE` meaning.
-- The column covers the SAME set of tables that carry a `userId` scope
-- column subject to per-user READ visibility: knowledge_fact,
-- knowledge_entity, knowledge_edge, episode, episode_segment. Two
-- userId-bearing tables are DELIBERATELY excluded: `answer_cache`
-- (0091) — its userId is a cache-partition key folded into the row
-- hash id and double-fenced there, not a visibility scope, and the rows
-- are ephemeral; and `conversation_digest` (0087) — it already carries
-- its own array-scope mechanism (`userScopes`), whose folding into this
-- tag grammar is a later step.
--
-- BEHAVIOR-IDENTICAL. This migration is inert until SCOPE_TAGS_ENABLED
-- is turned on, and even then the evaluator is an ADDITIONAL fence
-- composed with AND alongside the untouched userId filter, so it can
-- only narrow — never open — what userId filtering already returns. The
-- scope index mirrors the userId index where one exists (0055 defined
-- fact_user_idx / entity_user_idx; edge/episode/segment have none).
--
-- BACKFILL is explicit for BOTH branches and only fills unpopulated
-- rows: DEFINE FIELD ... DEFAULT applies at write time, not
-- retroactively, so pre-migration rows read as `scope IS NONE` until set
-- here. Guarding on `(scope IS NONE OR scope = [])` makes it idempotent
-- and never clobbers a scope a rolling-deploy write may have already
-- stamped.

-- ── knowledge_fact ──────────────────────────────────────────────
DEFINE FIELD IF NOT EXISTS scope ON knowledge_fact TYPE array<string> DEFAULT [];
DEFINE INDEX IF NOT EXISTS fact_scope_idx ON knowledge_fact FIELDS scope;
UPDATE knowledge_fact SET scope = ['user:' + userId]
  WHERE userId IS NOT NONE AND (scope IS NONE OR scope = []);
UPDATE knowledge_fact SET scope = []
  WHERE userId IS NONE AND scope IS NONE;

-- ── knowledge_entity ────────────────────────────────────────────
DEFINE FIELD IF NOT EXISTS scope ON knowledge_entity TYPE array<string> DEFAULT [];
DEFINE INDEX IF NOT EXISTS entity_scope_idx ON knowledge_entity FIELDS scope;
UPDATE knowledge_entity SET scope = ['user:' + userId]
  WHERE userId IS NOT NONE AND (scope IS NONE OR scope = []);
UPDATE knowledge_entity SET scope = []
  WHERE userId IS NONE AND scope IS NONE;

-- ── knowledge_edge ──────────────────────────────────────────────
-- Edges carry the userId column (0055) but no write path stamps it —
-- every edge is tenant-global — so the backfill only ever sets [].
DEFINE FIELD IF NOT EXISTS scope ON knowledge_edge TYPE array<string> DEFAULT [];
UPDATE knowledge_edge SET scope = ['user:' + userId]
  WHERE userId IS NOT NONE AND (scope IS NONE OR scope = []);
UPDATE knowledge_edge SET scope = []
  WHERE userId IS NONE AND scope IS NONE;

-- ── episode (L0 substrate, 0073) ────────────────────────────────
DEFINE FIELD IF NOT EXISTS scope ON episode TYPE array<string> DEFAULT [];
UPDATE episode SET scope = ['user:' + userId]
  WHERE userId IS NOT NONE AND (scope IS NONE OR scope = []);
UPDATE episode SET scope = []
  WHERE userId IS NONE AND scope IS NONE;

-- ── episode_segment (0075) ──────────────────────────────────────
DEFINE FIELD IF NOT EXISTS scope ON episode_segment TYPE array<string> DEFAULT [];
UPDATE episode_segment SET scope = ['user:' + userId]
  WHERE userId IS NOT NONE AND (scope IS NONE OR scope = []);
UPDATE episode_segment SET scope = []
  WHERE userId IS NONE AND scope IS NONE;
