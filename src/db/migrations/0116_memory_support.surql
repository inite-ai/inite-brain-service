-- 0116: memory_support — the ONE polymorphic typed support-edge table
-- (Drift-5). Kinds:
--   * supported_by    (knowledge_fact -> memory_episode): the claim is
--     grounded in that scene — the typed successor of the write-only
--     source.memoryEpisodeIds string stamps (scene-backlink keeps
--     writing the stamps; edges are ADDITIVE, PROVENANCE_SUPPORT_EDGES).
--   * contradicted_by (knowledge_fact -> knowledge_fact): conflict
--     standoffs from the resolver — SUPERSEDED writes one edge,
--     loser -> winner ("the old claim is contradicted by the new one");
--     COMPETING writes the mutual pair (both directions), capped by the
--     resolver's CONFLICT_OUTCOME_CAP idiom.
--   * derived_from    (summary knowledge_fact -> member knowledge_fact):
--     the typed mirror of the untyped `derivedFrom` array (0001) —
--     promotion/compaction insert, recompose deletes-then-reinserts its
--     summary's edges to track derivedFrom rewrites.
--   * reconstructed_from — RESERVED. Scene -> turn membership stays in
--     memory_episode_member (0106), the canonical representation; NO
--     writer emits this kind yet (the enum slot exists so future
--     non-scene reconstructions — e.g. consolidated summaries — have a
--     name without a schema change).
--
-- Endpoint-table pairing is enforced by the TS writer (assertEdgeShape,
-- src/common/support-edges.ts): `in`/`out` are DELIBERATELY untyped
-- records because one relation table cannot carry heterogeneous FROM/TO
-- types (fact->scene AND fact->fact) on 3.2.4.
--
-- 0106 doctrine applies: TYPE RELATION so graph tooling sees it, but
-- QUERIES MUST NOT use graph-arrow syntax — plain WHERE in/out only.
-- (The 0106-documented fallback — plain SCHEMAFULL table with explicit
-- in/out record fields — was NOT needed: RELATION-without-FROM/TO and
-- `INSERT RELATION IGNORE` were both verified against the pinned
-- surrealdb/surrealdb:v3.2.4 — IGNORE silently skips a UNIQUE
-- (in, out, kind) duplicate, so every writer is replay-idempotent.)
--
-- GDPR: BOTH forget cascades (user-forget, entity-forget) erase this
-- table's rows for their subjects UNCONDITIONALLY — rows written while
-- PROVENANCE_SUPPORT_EDGES was on must stay erasable after it is off
-- (the EVIDENCE_SUBSTRATE_ENABLED precedent).
--
-- No CHANGEFEED and no DEFINE EVENT (the 0053/0107 separation rationale):
-- provenance edges must not feed the audit mirror or any dirty-marking
-- event, and an erased subject's edges must not stay readable in a feed.
DEFINE TABLE IF NOT EXISTS memory_support SCHEMAFULL TYPE RELATION;

DEFINE FIELD IF NOT EXISTS in  ON memory_support TYPE record;
DEFINE FIELD IF NOT EXISTS out ON memory_support TYPE record;
DEFINE FIELD IF NOT EXISTS kind ON memory_support TYPE string
  ASSERT $value INSIDE ['supported_by', 'contradicted_by', 'derived_from', 'reconstructed_from'];
-- Provenance of the edge itself (which code path asserted it, when).
DEFINE FIELD IF NOT EXISTS writer ON memory_support TYPE string
  ASSERT $value INSIDE ['scene_backlink', 'fact_resolver', 'promotion_runner', 'compaction_runner', 'recompose'];
DEFINE FIELD IF NOT EXISTS writerVersion ON memory_support TYPE option<string>;
DEFINE FIELD IF NOT EXISTS createdAt ON memory_support TYPE datetime DEFAULT time::now();

-- Dedupe/idempotency + the two read paths (by claim, by target).
-- NOTE 3.2.4: the compound UNIQUE index puts `in` under the planner bug
-- class where `DELETE memory_support WHERE in INSIDE $x` is a SILENT
-- no-op (returns OK, deletes zero rows) while the same WHERE in a
-- SELECT matches — REPRODUCED against the pinned server on THIS exact
-- table during this migration's smoke. Every deleter MUST use the
-- two-step idiom: LET $ids = (SELECT VALUE id ...); DELETE $ids;
DEFINE INDEX IF NOT EXISTS support_edge_uq  ON memory_support FIELDS in, out, kind UNIQUE;
DEFINE INDEX IF NOT EXISTS support_out_idx  ON memory_support FIELDS out;
DEFINE INDEX IF NOT EXISTS support_kind_idx ON memory_support FIELDS kind;
