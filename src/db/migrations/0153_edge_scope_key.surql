-- 0153_edge_scope_key — the per-user scope reaches knowledge_edge.
--
-- WHY. 0055 gave every memory row a `userId` (NONE = tenant-global) and
-- every read a fail-closed fence, but only facts and entities were ever
-- WRITTEN with it: the edge writers stamped nothing, so a relation
-- extracted from a user's personal turn ("Maria works at Orbital") was
-- tenant-global while the facts from the same turn were personal. The
-- edge fence (search/internals/edge-fence.ts) let it through as
-- `userId IS NONE`, and the answer plane cites edges as evidence.
--
-- Identity of an edge is (in, out, kind) WITHIN A SCOPE — the same rule
-- the entity key folds into `::u::`. A unique index cannot carry the
-- scope as `userId` directly: SurrealDB 3.2.4 does not enforce
-- uniqueness on a composite key with a NONE component (measured: three
-- global RELATEs of one triple all succeeded under
-- UNIQUE(in, out, kind, userId)). So the scope is folded into a computed
-- string that is never NONE — '' for tenant-global, the userId
-- otherwise — and 0154 keys the unique index on it.
--
-- Two files, not one: an index defined in the SAME transaction as the
-- backfill is built over the pre-transaction rows (scopeKey NONE) and
-- never enforces on them afterwards — measured on 3.2.4; the rebuild
-- must see the committed backfill.
DEFINE FIELD IF NOT EXISTS scopeKey ON knowledge_edge TYPE string VALUE userId ?? '';

-- Backfill: rewriting the row evaluates the VALUE clause for rows that
-- predate the field. Every existing edge is tenant-global.
UPDATE knowledge_edge SET userId = userId WHERE scopeKey IS NONE;
