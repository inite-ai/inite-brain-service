-- 0089_staleness_event — write-time derived-fact staleness (closes the
-- 0072 latency window).
--
-- 0072 built the machinery — staleAt/staleReason + fn::mark_derived_stale —
-- but left the TRIGGER nightly: RecomposeService drains the changefeed at
-- 03:05 UTC and only then marks the derived descendants of superseded /
-- retracted parents. Between a parent's correction and the next drain a
-- compaction summary keeps serving the stale value for up to 24h. This event
-- closes that window: the moment a parent's status TRANSITIONS into
-- 'superseded' or 'retracted', its reverse-derivedFrom closure is marked
-- stale inside the same transaction, by the same stored function the drain
-- calls.
--
-- THE GUARD (every clause is a storm defence — all four proven on a real
-- SurrealDB 3.1.5 with the derive-flip shapes, see
-- test/staleness-event.e2e-spec.ts):
--
--   1. $event = 'UPDATE' — never CREATE, never DELETE. The batch deriver
--      bulk-CREATEs rows that are BORN 'superseded' (supersede chains inside
--      a derived world) — a freshly created row cannot have pre-existing
--      dependents, so firing there is pure waste. And promoteStaging's
--      atomic flip DELETEs the whole final version in one statement — with
--      no DELETE arm the event does not even evaluate there.
--
--   2. $before.status != $after.status — the cheap TRANSITION check. No-op
--      UPDATEs, content edits, and every non-status write fall through. This
--      clause is also the RECURSION guard: fn::mark_derived_stale writes
--      only staleAt/staleReason, never status, so its own UPDATEs re-enter
--      the WHEN and evaluate false — marking cannot re-fire the event.
--
--   3. $after.status IN ['superseded', 'retracted'] — the same
--      CONTENT_CHANGED vocabulary the nightly drain filters on
--      (recompose.service.ts). Direction matters: the REVIVE transitions
--      ('superseded' -> 'active' in promoteStaging's targeted flip and in
--      reviveSupersededBy, 'retracted' -> 'active' in fn::revive) do not
--      match. 'compacted' is deliberately absent for 0072's reason:
--      compaction sets its sources to 'compacted' in the pass that CREATES
--      the summary from them — treating that as a change would mark every
--      summary stale at birth. No separate retractedAt clause is needed:
--      audited 2026-08 — every live writer that sets retractedAt flips
--      status in the same statement (fn::cascade_retract 0069, the retract
--      API's merge, recompose's retractOrphan); the only statements that
--      ever wrote retractedAt without being paired to a status flip were
--      pre-0033 fn::resolve_fact versions, long overwritten.
--
--   4. $after.derivedVersion IS NONE — derive-run rows are excluded
--      entirely. During a derive run fn::resolve_facts performs thousands
--      of genuine supersede transitions inside the staging namespace;
--      staging/derived-world rows never carry compaction-summary dependents
--      in the live world, so each fire would pay fn::mark_derived_stale's
--      CONTAINSANY table pass for nothing. Pinned-world compaction
--      summaries (compaction CAN run over a pinned derived version) keep
--      the nightly-drain path they had before this migration — no
--      regression, just no low-latency upgrade for them.
--
-- COST. A genuine fire runs one CONTAINSANY pass over knowledge_fact per
-- recursion level. Measured on 3.1.5: the query planner does NOT serve
-- CONTAINSANY from a standard index (EXPLAIN shows TableScan with or
-- without an index on derivedFrom), so no index is added here — it would be
-- dead weight on every write. The firing population (real supersede/retract
-- transitions on live rows) is exactly the population the drain scanned for
-- anyway; the work moved from 03:05 to write time.
--
-- DEPTH. fn::mark_derived_stale recurses level by level; `staleAt IS NONE`
-- makes marking monotone, so it terminates even on cyclic derivedFrom data.
-- A chain deeper than SurrealDB's computation-depth limit would abort the
-- triggering write — compaction lineage is depth <= 3 in practice.
--
-- BACKSTOP. The nightly drain (RecomposeService.invalidate) stays as the
-- catch-all: it covers rows written while the event was absent (pre-0089
-- history, an operator REMOVE EVENT window), derived-world parents excluded
-- by clause 4, and any future writer whose transition shape the guard does
-- not anticipate.
--
-- REMOVAL. Events are schema, not runtime configuration — there is no flag.
-- To disable on a tenant:
--     REMOVE EVENT fact_staleness ON TABLE knowledge_fact;
-- The nightly drain then carries the whole load again, exactly as pre-0089.

DEFINE EVENT OVERWRITE fact_staleness ON TABLE knowledge_fact
    WHEN $event = 'UPDATE'
        AND $before.status != $after.status
        AND $after.status IN ['superseded', 'retracted']
        AND $after.derivedVersion IS NONE
    THEN {
        -- Same reason string the drain writes — one vocabulary downstream.
        fn::mark_derived_stale([$after.id], 'parent_changed', time::now());
    };
