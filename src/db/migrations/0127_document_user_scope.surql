-- 0127_document_user_scope — per-user scope for the Source layer.
--
-- INGEST_MENTION_VIA_DOCUMENT fail-closed (HTTP 400) on ANY user-scoped
-- mention because source_document could not carry per-user scope (0048):
-- routing such a mention through the pipeline would have landed the
-- user's memory tenant-global (the audit 2026-08-21 P0 class). With the
-- flag enabled in prod, that guard broke the PRIMARY per-user write path.
--
-- These columns give the document row the same 0055 `userId` + 0093
-- `scope` shape as knowledge_fact / episode, so the wrapper can thread
-- the mention's userId end-to-end instead of refusing:
--   * DocumentStoreService persists it (and salts the dedupe/origin
--     contentHash with the user scope so a user's document can never
--     dedupe onto a tenant-global one or another user's);
--   * CommitWriterService stamps every committed fact through
--     fn::resolve_fact's user_id param — the SAME machinery the direct
--     mention path uses, so fact rows carry identical userId + scope;
--   * SceneCandidateWriterService stamps projected memory_episode rows
--     (userId + scope + 0117 userIds);
--   * the documents read surface fences user-scoped rows (pinUserScope);
--   * user-forget reaches the user's documents BY COLUMN, closing the
--     0108 "zero committed facts" limit for user-scoped documents.
--
-- NONE/absent userId = tenant-global — pre-existing rows and the
-- flag-off / no-userId paths are byte-identical.
--
-- Single-field index only (the entity_user_idx mold): the 3.2.4
-- compound-index planner gotcha (PR #372 class) keeps scope columns off
-- compound shapes, and every forget DELETE pre-selects ids anyway.

DEFINE FIELD IF NOT EXISTS userId ON source_document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope  ON source_document TYPE array<string> DEFAULT [];

DEFINE INDEX IF NOT EXISTS source_document_user_idx ON source_document FIELDS userId;
