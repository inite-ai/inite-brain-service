-- 0072_derived_staleness — mark derived facts STALE when a parent changes.
--
-- Phase 1 of docs/roadmap/cascade-recompose-2026-07.md.
--
-- THE HOLE THIS CLOSES. `fn::resolve_fact` (0055) — the path every routine
-- fact UPDATE takes — never touches `derivedFrom`. So a compaction summary
-- keeps serving a value its parent has already corrected, silently and
-- forever. The only cascade in the system (`fn::cascade_retract`, 0069) fires
-- from exactly one call site: the explicit retract API. Consolidation
-- (`applySupersedes`) made this worse — it writes status='superseded', which
-- cascade_retract cannot see at all (it filters `retractedAt IS NONE`).
--
-- WHY STALE AND NOT RETRACT. The naive patch — cascade a retract on supersede —
-- would DESTROY a summary on every routine fact update. Worse, compaction sets
-- its sources to status='compacted' and drops their embeddings
-- (compaction-runner.service.ts:135), and every read surface hides
-- 'compacted' — so the summary is the ONLY carrier of that knowledge. Deleting
-- it loses facts that are still true. The artifact must be RE-DERIVED over its
-- surviving parents; retraction is correct only when no parent survives.
--
-- So this migration marks, and a recompute pass acts. A stale summary keeps
-- being served in the meantime: it is stale, but it is better than the nothing
-- that hiding it would leave behind.

DEFINE FIELD IF NOT EXISTS staleAt ON knowledge_fact TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS staleReason ON knowledge_fact TYPE option<string>;

-- The recompute pass selects on this; without an index it is a full scan of
-- every fact in the tenant per pass.
DEFINE INDEX IF NOT EXISTS fact_stale_idx ON knowledge_fact FIELDS staleAt;

-- Reverse-`derivedFrom` closure, level by level — the same shape
-- `fn::cascade_retract` (0069) proves on 3.x, and for the same reasons: ONE
-- set-based UPDATE per level rather than N+1 round-trips, and the frontier
-- passed as an ARGUMENT so there is no cross-iteration variable reassignment
-- (the SurrealQL FOR-loop gotcha).
--
-- `staleAt IS NONE` in the WHERE does double duty exactly as `retractedAt IS
-- NONE` does there: it makes the call idempotent, and it TERMINATES the
-- recursion (a fully-marked frontier yields no new children).
--
-- Returns the flat list of newly-marked ids, children-first per level.
DEFINE FUNCTION OVERWRITE fn::mark_derived_stale(
    $parents: array<record<knowledge_fact>>,
    $reason: string,
    $now: datetime
) {
    LET $children = (
        UPDATE knowledge_fact SET
            staleAt = $now,
            staleReason = $reason
        WHERE derivedFrom CONTAINSANY $parents
          AND staleAt IS NONE
          AND retractedAt IS NONE
        RETURN id
    );
    LET $childIds = array::distinct($children.id ?? []);
    IF array::len($childIds) == 0 {
        RETURN [];
    };
    RETURN array::concat(
        $childIds.map(|$c| type::string($c)),
        fn::mark_derived_stale($childIds, $reason, $now)
    );
};
