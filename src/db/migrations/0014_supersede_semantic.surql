-- 0014_supersede_semantic — separate "natural supersede" from "retract".
--
-- Bug found in the live demo: with `address` reclassified to single_active
-- (migration via JS policy), Tell #1 "Maria lives in Berlin" landed,
-- Tell #2 "Maria moves to Dunlin NEXT MONTH" arrived with future
-- validFrom. fn::resolve_fact correctly auto-closed Berlin with
-- validUntil=July, but ALSO set retractedAt=now. The default-now
-- graphSearch query filters retractedAt IS NONE → Berlin excluded
-- even though it's still the truth NOW (validUntil > now).
--
-- The semantics were confused. Bitemporal databases (Snodgrass, SQL:2011)
-- distinguish two operations:
--
--   • Sequenced supersede / natural state change. Wikidata pattern:
--     "X used to live in Berlin; X now lives in Dublin". Both facts are
--     TRUE at their respective times. The old fact's validity ends at
--     the new fact's validFrom — validUntil := newFact.validFrom. The
--     old fact is NOT a correction; it was true and the timeline shows
--     it as such. retractedAt MUST NOT be set.
--
--   • Retract / correction. "X never actually lived in Berlin; that was
--     wrong". The old fact is excluded from EVERY asOf slice. Set
--     retractedAt = now AND validUntil := now. We don't auto-fire this;
--     it's an explicit operator action (POST /v1/facts/:id/retract).
--
-- fn::resolve_fact was conflating both. Fix: the supersede branch only
-- sets validUntil + supersededBy + status='superseded' (informational).
-- retractedAt stays NONE so the natural-state-change predecessor remains
-- visible at asOf within its window. Compaction is also untouched.

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

    LET $candidates = SELECT
        id, predicate, object, confidence, recordedAt, source, embedding,
        validFrom, validUntil
    FROM knowledge_fact
    WHERE entityId = $entity_id
      AND predicate = $predicate
      AND status = 'active'
      AND retractedAt IS NONE;

    LET $competing = IF $semantics = 'append_only' THEN
        []
    ELSE IF $semantics = 'single_active' THEN
        $candidates
    ELSE
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
        -- Sequenced supersede: close the prior at the new fact's
        -- validFrom and mark it superseded (informational). DO NOT set
        -- retractedAt — that would erase the predecessor from every
        -- asOf slice, which is wrong for natural state changes. The
        -- predecessor IS the truth in its window.
        UPDATE knowledge_fact SET
            status = 'superseded',
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

-- Repair any existing rows that were superseded under the OLD semantics
-- (retractedAt set even though they were natural state changes, not
-- corrections). Heuristic: a row is a natural-supersede when status
-- ='superseded' AND supersededBy IS NOT NONE AND retractionReason
-- ='superseded'. Clear retractedAt + retractionReason + retractedBy so
-- the bitemporal slice sees them again at asOf within their window.
UPDATE knowledge_fact
   SET retractedAt = NONE,
       retractionReason = NONE,
       retractedBy = NONE
 WHERE status = 'superseded'
   AND supersededBy IS NOT NONE
   AND retractionReason = 'superseded';
