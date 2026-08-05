-- 0069_cascade_retract — atomic derivedFrom cascade as a stored function.
--
-- When a fact is retracted, every fact DERIVED from it (transitively, via the
-- derivedFrom array) must also be retracted. The TS implementation
-- (facts.service.ts cascadeRetract) did this as a DAG walk: one SELECT for a
-- node's children, then one UPDATE per child, per node — N+1 round-trips, and
-- interleavable with a concurrent retract or a child inserted mid-walk. Its
-- sibling reviveSupersededBy was already collapsed to one set-based UPDATE;
-- this is the last leg left as a loop.
--
-- fn::cascade_retract walks the reverse derivedFrom closure in a single atomic
-- call: one set-based UPDATE per LEVEL (all children of the current frontier at
-- once, via CONTAINSANY), recursing on the ids it just retracted. The frontier
-- is passed as an argument, so there is no cross-iteration variable-reassignment
-- (the SurrealQL FOR-loop gotcha) — the recursion carries state. `retractedAt IS
-- NONE` in the WHERE skips already-retracted facts (idempotent, and independent
-- retracts keep their state) and also terminates the recursion (a fully-retracted
-- frontier returns no new children). Verified on SurrealDB 3.2.0.
--
-- Semantics mirror the prior TS exactly: status='retracted', retractedAt=$now,
-- retractedBy='cascade', retractionReason='parent retracted: '+$reason,
-- validUntil=$now. Returns the flat list of cascaded fact ids (as strings),
-- children-first per level, matching the old return order closely enough for
-- callers (order within a level is unspecified either way).

DEFINE FUNCTION OVERWRITE fn::cascade_retract(
    $parents: array<record<knowledge_fact>>,
    $reason: string,
    $now: datetime
) {
    LET $children = (
        UPDATE knowledge_fact SET
            status = 'retracted',
            retractedAt = $now,
            retractedBy = 'cascade',
            retractionReason = 'parent retracted: ' + $reason,
            validUntil = $now
        WHERE derivedFrom CONTAINSANY $parents
          AND retractedAt IS NONE
        RETURN id
    );
    LET $childIds = array::distinct($children.id ?? []);
    IF array::len($childIds) == 0 {
        RETURN [];
    };
    RETURN array::concat($childIds, fn::cascade_retract($childIds, $reason, $now));
};
