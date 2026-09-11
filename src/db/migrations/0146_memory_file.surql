-- 0146: memory_file — file-shaped memory, backed by the graph.
--
-- WHY. The Anthropic memory tool (`memory_20250818`) gives a model a
-- filesystem it owns: view / create / str_replace / insert / delete /
-- rename under `/memories`. The developer supplies the storage. Whoever
-- supplies it owns that team's memory, and today everyone supplies a
-- directory on disk — which forgets on redeploy, is invisible to every
-- other surface, and knows nothing about time.
--
-- This table is brain's answer. A team already using the memory tool
-- swaps the backend and keeps their agent loop byte-identical, and the
-- notes stop being a directory that forgets on redeploy: they live in
-- the tenant's database, behind the same auth, visible to the same
-- fences, surviving the same way every other memory does. The file
-- surface is exact — it has to be, str_replace is a string operation on
-- the text the model last wrote.
--
-- WHERE IT LIVES. Per-tenant (`co_*`), like every other memory table.
-- The path is the identity, so the unique index is on (path, userId):
-- two people sharing a workspace key each get their own `/memories`,
-- the same fence every other per-user surface uses (0055). A NONE
-- userId is the workspace-wide file, and it is a DIFFERENT row from any
-- user's file at the same path — that is deliberate; the alternative is
-- one person's note silently overwriting another's.
--
-- NOT versioned. The memory tool's own semantics are last-write-wins on
-- a path, and a model that edits a file twenty times in a session would
-- write twenty revisions nobody reads. History that matters belongs in
-- the fact timeline, which the ingest path already produces and which
-- is bitemporal for real.
--
-- ADDITIVE. New table, every statement IF NOT EXISTS, no data mutation.
-- Nothing reads it unless the memory-file API is called.

DEFINE TABLE IF NOT EXISTS memory_file SCHEMAFULL;

-- Absolute path inside the model's memory directory. The API rejects
-- anything that does not start with `/memories` and anything containing
-- `..` before it reaches here; the assert is the last line of defence.
DEFINE FIELD IF NOT EXISTS path ON memory_file TYPE string
    ASSERT string::len($value) > 0
       AND string::len($value) <= 512
       AND string::starts_with($value, '/memories');

-- The file's contents, verbatim. Capped so one runaway write cannot
-- fill a tenant's database; the API enforces the same number and
-- answers with a clear error rather than a database assertion.
DEFINE FIELD IF NOT EXISTS content ON memory_file TYPE string
    ASSERT string::len($value) <= 100000;

-- End-user this file belongs to (0055). NONE = the workspace-wide file.
DEFINE FIELD IF NOT EXISTS userId ON memory_file TYPE option<string>;

DEFINE FIELD IF NOT EXISTS createdAt ON memory_file TYPE datetime
    DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updatedAt ON memory_file TYPE datetime
    DEFAULT time::now();

-- Identity. The compound index is what makes a path a path: one row per
-- (path, owner), and an upsert that targets it is the whole write path.
DEFINE INDEX IF NOT EXISTS memory_file_path_user
    ON memory_file FIELDS path, userId UNIQUE;

-- Directory listing: `view` on a directory is a prefix scan, and the
-- tool calls it on every turn a model orients itself.
DEFINE INDEX IF NOT EXISTS memory_file_path
    ON memory_file FIELDS path;
