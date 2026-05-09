-- 0009_allen_overlap — bitemporal correctness in conflict resolution.
--
-- Problem caught by the memory-lifecycle eval (memlc.update.tier-upgrade,
-- memlc.supersede-chain.tier-trajectory): bitemporal predicates with an
-- explicit `validUntil` ON THE OLDER fact + a smaller-than-margin
-- confidence gap left BOTH facts in status='active'. Default search
-- (under the new bitemporal-actual-now closure in 0009's sibling JS
-- change) hides them via the validUntil filter, but the DB still
-- carries them as active siblings, polluting timeline reads and
-- COMPETING-checks on subsequent ingests.
--
-- Fix: Allen's interval algebra in the conflict resolver. Two facts
-- conflict only when their validity intervals OVERLAP. Sequential
-- intervals (the older fact's validUntil ≤ newer fact's validFrom)
-- are NOT in conflict; the older one is just historical, the newer
-- one is the natural successor. Same physics that lets a tier
-- ladder (standard → gold → platinum, each with explicit validUntil)
-- coexist as a clean timeline rather than three competing actives.
--
-- Cosine similarity remains the second-stage gate (a fact must be
-- about the SAME object to count as competing). Allen's check
-- composes with cosine, doesn't replace it.

-- Allen's overlap predicate. Returns true iff [a_from, a_until) and
-- [b_from, b_until) overlap. Open-ended intervals (validUntil IS NONE)
-- are treated as extending to +∞, with the standard NONE-handling
-- short-circuits.
DEFINE FUNCTION OVERWRITE fn::intervals_overlap(
    $a_from: datetime,
    $a_until: option<datetime>,
    $b_from: datetime,
    $b_until: option<datetime>
) {
    -- Two intervals overlap iff a.from < b.until AND b.from < a.until.
    -- Open-end (NONE) shortcircuits the corresponding inequality
    -- since +∞ is greater than any concrete datetime.
    LET $a_starts_before_b_ends = ($b_until IS NONE) OR ($a_from < $b_until);
    LET $b_starts_before_a_ends = ($a_until IS NONE) OR ($b_from < $a_until);
    RETURN $a_starts_before_b_ends AND $b_starts_before_a_ends;
};

-- Updated resolve_fact: bitemporal $competing now Allen's-overlap-gated.
-- single_active retains its all-prior-actives behaviour because the
-- semantics define ONLY ONE active row at a time (overlap is implied
-- by definition; a non-overlapping single_active doesn't make sense).
-- append_only is unchanged (no conflict possible).
DEFINE FUNCTION OVERWRITE fn::resolve_fact(
    $entity_id: record<knowledge_entity>,
    $predicate: string,
    $object: string,
    $object_meta: option<object>,
    $embedding: array<float>,
    $confidence: float,
    $valid_from: datetime,
    $valid_until: option<datetime>,
    $source: object,
    $source_trust: float,
    $semantics: string,
    $similarity_threshold: float,
    $w_confidence: float,
    $w_source_trust: float,
    $w_recency: float,
    $w_authority: float,
    $reject_threshold: float,
    $margin_for_supersede: float
) {
    LET $new_score =
        $w_confidence * $confidence
        + $w_source_trust * $source_trust
        + $w_recency * 1.0
        + $w_authority * 0.0;

    IF $semantics = 'bitemporal' AND $new_score < $reject_threshold {
        CREATE ingest_dead_letter CONTENT {
            payload: { entityId: $entity_id, predicate: $predicate, object: $object, source: $source },
            reason: 'low_score: ' + <string>$new_score
        };
        RETURN { outcome: 'REJECTED', factId: NONE, reason: 'low_score' };
    };

    -- Pull active candidates: same entity, same predicate, not retracted.
    -- We additionally fetch validFrom / validUntil so the overlap check
    -- can exclude sequential intervals downstream.
    LET $candidates = SELECT
        id, predicate, object, confidence, recordedAt, source, embedding,
        validFrom, validUntil
    FROM knowledge_fact
    WHERE entityId = $entity_id
      AND predicate = $predicate
      AND status = 'active'
      AND retractedAt IS NONE;

    -- Branch by semantics for "what counts as competing".
    LET $competing = IF $semantics = 'append_only' THEN
        []
    ELSE IF $semantics = 'single_active' THEN
        -- single_active is by definition one row at a time — every
        -- prior active conflicts with the new one regardless of
        -- interval. The supersede branch below handles cleanup.
        $candidates
    ELSE
        -- bitemporal: cosine ≥ threshold AND Allen's-overlap with
        -- the new fact's validity interval.
        (SELECT * FROM $candidates
            WHERE embedding != NONE
              AND vector::similarity::cosine(embedding, $embedding) >= $similarity_threshold
              AND fn::intervals_overlap(validFrom, validUntil, $valid_from, $valid_until))
    END;

    LET $new = CREATE ONLY knowledge_fact CONTENT {
        entityId: $entity_id,
        predicate: $predicate,
        object: $object,
        objectMeta: $object_meta,
        confidence: $confidence,
        validFrom: $valid_from,
        validUntil: $valid_until,
        source: $source,
        embedding: $embedding,
        status: 'active'
    };

    IF array::len($competing) = 0 {
        RETURN { outcome: 'INSERTED', factId: $new.id, reason: NONE };
    };

    LET $scored = SELECT
        id,
        ($w_confidence * confidence
         + $w_source_trust * 0.5
         + $w_recency * math::pow(math::E, - duration::secs(time::now() - recordedAt) / 31536000)
         + $w_authority * 0.0
        ) AS score
    FROM $competing;

    LET $best_opp = math::max($scored.score);
    LET $supersede =
        $semantics = 'single_active'
        OR $new_score >= $best_opp + $margin_for_supersede;

    LET $loser_ids = $competing.id;

    IF $supersede {
        UPDATE knowledge_fact SET
            status = 'superseded',
            retractedAt = time::now(),
            retractionReason = 'superseded',
            retractedBy = 'system',
            supersededBy = $new.id,
            validUntil = $valid_from
        WHERE id IN $loser_ids;
        RETURN {
            outcome: 'SUPERSEDED',
            factId: $new.id,
            supersededFactIds: $loser_ids,
            reason: NONE
        };
    };

    UPDATE $new.id SET status = 'competing';
    UPDATE knowledge_fact SET status = 'competing' WHERE id IN $loser_ids;
    RETURN {
        outcome: 'COMPETING',
        factId: $new.id,
        competingFactIds: $loser_ids,
        reason: NONE
    };
};
