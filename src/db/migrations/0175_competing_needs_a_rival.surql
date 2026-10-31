-- 0175: a fact stays 'competing' only while it has an open rival.
--
-- COMPETING is a relation between facts — two values that cannot both be
-- true, neither replacing the other. Every writer that ends a fact's part
-- in it (supersede, retract, corroborate, compaction) changed only the
-- leaving row, so the fact it was competing WITH stayed 'competing' alone,
-- with nothing to compete against. Measured on the memory-fitness corpus
-- (key-less stand, 2026-10-31): fn::resolve_fact marked "8081" and its
-- paraphrase "8081 (internal admin console)" competing by a 0.045 score
-- margin; fact resolution (#828) then made the paraphrase corroborate the
-- incumbent — and the incumbent, the slot's only current value, stayed
-- 'competing'. 4 of the 6 competing rows were alone this way (admin
-- console port, metrics port, repository, the current retry policy). The
-- graph lane (internals/graph-retrieve-db.ts) and the user profile filter
-- `status != 'competing'` and also drop corroborating copies, so those
-- values were gone from them entirely. A retracted competitor left the
-- same orphan long before #828.
--
-- A rival of fact F is an open (retractedAt NONE) 'competing' row that is
-- either in F's slot — the pool fn::resolve_fact (0172) resolves in:
-- same entity, canonical predicate, user, circle tags and derivedVersion —
-- or linked to F by its conflict trace (bestOpponentId, written by
-- fn::resolve_fact; competingFactIds, written by fact resolution for two
-- facts that contradict across predicate names, which no slot pairs).
--
-- The event restores the invariant inside the writer's own transaction,
-- for every writer at once: when a 'competing' row leaves (any status
-- transition out of 'competing' other than into 'active'), each other
-- 'competing' row of the same entity left with no rival becomes 'active'.
-- Recursion guard: the event writes only competing → active, which its
-- WHEN does not match. Cost: one entityId-indexed pass over the entity's
-- competing rows, each checked by one more — fired only when a competing
-- row closes. Rows are checked one by one against the table as it stands
-- mid-update; that is safe because a row only becomes 'active' when it has
-- no rival, so turning it cannot take a rival away from another.
--
-- Backfill: every live 'competing' row with no rival becomes 'active'.

DEFINE FUNCTION OVERWRITE fn::fact_has_rival($f: object) -> bool {
    RETURN array::len((
        SELECT VALUE id FROM knowledge_fact
        WHERE entityId = $f.entityId
          AND status = 'competing'
          AND retractedAt IS NONE
          AND id != $f.id
          AND (
            (
              (predicateAlias ?? predicate) = ($f.predicateAlias ?? $f.predicate)
              AND (IF $f.userId IS NONE THEN userId IS NONE ELSE userId = $f.userId END)
              AND array::sort((scope ?? []).filter(|$t| string::starts_with($t, 'circle:')))
                  = array::sort(($f.scope ?? []).filter(|$t| string::starts_with($t, 'circle:')))
              AND (IF $f.derivedVersion IS NONE THEN derivedVersion IS NONE
                   ELSE derivedVersion = $f.derivedVersion END)
            )
            OR conflictTrace.bestOpponentId = $f.id
            OR $f.id INSIDE (conflictTrace.competingFactIds ?? [])
            OR id = $f.conflictTrace.bestOpponentId
            OR id INSIDE ($f.conflictTrace.competingFactIds ?? [])
          )
        LIMIT 1
    )) > 0;
};

DEFINE EVENT OVERWRITE competing_needs_a_rival ON TABLE knowledge_fact
    WHEN $event = 'UPDATE'
        AND $before.status = 'competing'
        AND $after.status != 'competing'
        AND $after.status != 'active'
    THEN {
        UPDATE knowledge_fact SET status = 'active'
        WHERE entityId = $before.entityId
          AND status = 'competing'
          AND retractedAt IS NONE
          AND id != $before.id
          AND !fn::fact_has_rival($this);
    };

-- One statement, no FOR: on 3.2.4 `FOR $x IN (SELECT …)` over an empty
-- selection fails ("Cannot execute statement using value: NONE"), which
-- every tenant without a competing row would hit.
UPDATE knowledge_fact SET status = 'active'
WHERE status = 'competing'
  AND retractedAt IS NONE
  AND !fn::fact_has_rival($this);
