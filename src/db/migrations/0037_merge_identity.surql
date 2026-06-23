-- 0037_merge_identity — atomic identity_of merge with server-side cycle guard.
--
-- Before this, ingestLink() ran the cycle guard and the mergedInto write as
-- separate round-trips: a bounded 32-hop TS walk of the survivor's chain,
-- then (after the RELATE) a standalone `UPDATE ... SET mergedInto`. Two
-- problems:
--   1. TOCTOU window. The decision (walk) and the write (merge) were
--      different network calls, so any interleaving mutation between them
--      could invalidate the check. The classic failure is a mutual merge
--      A→B and B→A: both walks observe an empty chain, both commit, and
--      BOTH entities end up with mergedInto set — so both vanish from
--      retrieval, since survivor resolution is single-hop
--      (`WHERE mergedInto IS NONE`).
--   2. Extra round-trips: up to 32 SELECTs for the walk + 1 UPDATE.
--
-- fn::merge_identity folds the whole read-decide-write into one statement
-- (one transaction):
--   * self-merge guard,
--   * a sorted-pair lock row so concurrent reverse merges of the same pair
--     collide on a single record write — SurrealDB aborts one with a
--     retryable conflict; the caller's retryOnUniqueViolation re-runs it,
--     and the second attempt observes the committed merge and trips the
--     cycle guard. This is what actually serializes the mutual-merge race;
--     single-transaction atomicity alone does not, because snapshot
--     isolation would let two reverse merges each read an empty chain.
--   * a multi-hop cycle guard via the recursive path operator
--     `$survivor.{1..32+collect}.mergedInto` (bounded to 32 hops, so a
--     pre-existing cycle can never spin), rejecting the merge when the
--     survivor already resolves transitively to the loser.
--
-- The knowledge_edge `identity_of` record is still RELATEd by ingestLink;
-- only the cycle check + mergedInto write move here. Calling the function
-- BEFORE the RELATE preserves the "reject before any write" contract: a
-- cycle returns merged=false having written nothing.

-- Lock table. SCHEMALESS — the only consumer is fn::merge_identity, keyed by
-- the sorted "loser|survivor" pair. One tiny row per distinct merged pair.
DEFINE TABLE IF NOT EXISTS merge_lock SCHEMALESS;

DEFINE FUNCTION OVERWRITE fn::merge_identity(
    $loser: record<knowledge_entity>,
    $survivor: record<knowledge_entity>
) {
    IF $loser = $survivor {
        RETURN { merged: false, reason: 'self_merge' };
    };

    -- Serialize concurrent merges of the same (unordered) pair. A→B and
    -- B→A both hash to the same lock record, so one of two racing
    -- transactions aborts with a retryable write conflict.
    LET $pair = array::sort([<string>$loser, <string>$survivor]);
    UPSERT type::thing('merge_lock', array::join($pair, '|')) SET at = time::now();

    -- Multi-hop cycle guard. `+collect` returns every mergedInto value along
    -- the survivor's chain; if the loser is anywhere in it, merging the loser
    -- into the survivor would close a cycle. `?? []` covers a survivor that
    -- is itself a root (empty chain).
    LET $chain = $survivor.{1..32+collect}.mergedInto;
    IF $loser IN ($chain ?? []) {
        RETURN { merged: false, reason: 'cycle' };
    };

    UPDATE $loser SET mergedInto = $survivor, mergedAt = time::now();
    RETURN { merged: true, reason: NONE };
};
