-- 0043_resolve_fact_backdated_guard — stop a BACKDATED single_active fact
-- from displacing the CURRENT one.
--
-- Before this migration `$supersede = $semantics = 'single_active' OR ...`
-- was unconditional for single_active: whatever fact arrived LAST won,
-- regardless of validFrom. A late-arriving fact with an OLD validFrom
-- (batch capture replaying history newest-first, a re-run of
-- `capture:decisions` over an old range, any out-of-order event source)
-- would supersede the standing newer decision AND leave the loser with an
-- inverted interval (validUntil = incoming.validFrom < loser.validFrom) —
-- invisible to every asOf query.
--
-- Fix: for single_active, when at least one active candidate has
-- validFrom > $valid_from the incoming fact is HISTORY, not the present.
-- Insert it as an already-superseded historical row slotted before the
-- next-newer decision (validUntil = that decision's validFrom,
-- supersededBy = its id) and leave every active fact untouched. New
-- outcome 'INSERTED_HISTORICAL' so callers can tell it apart from a
-- winning insert. Equal validFrom keeps the old behaviour (same-instant
-- re-decide still wins) — the guard is strictly `>`.
--
-- The future-dated direction (incoming NEWER than incumbent) is untouched
-- — see test/future-supersede-gap.e2e-spec.ts for that contract.
--
-- Body is migration 0039 VERBATIM plus the $next_after guard between the
-- INSERTED early-return and the scoring block. Nothing else changes.

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
    $margin_for_supersede: float,
    $lang: option<string>,
    $script: option<string>,
    $entropy: option<float>
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
        -- Locale + entropy folded in from the caller (migration 0039). Applied
        -- on INSERTED only, matching the old post-call UPDATE gate.
        IF $lang != NONE {
            UPDATE $new.id SET lang = $lang, script = $script;
        };
        IF $entropy != NONE {
            UPDATE $new.id SET extractionEntropy = $entropy;
        };
        RETURN { outcome: 'INSERTED', factId: $new.id, reason: NONE };
    };

    -- Backdated guard (migration 0043): for single_active, a candidate with
    -- a STRICTLY NEWER validFrom means the incoming fact is history. Slot it
    -- before the next-newer decision as an already-superseded row; the
    -- active timeline stays exactly as if events had arrived in order.
    LET $next_after = IF $semantics = 'single_active' THEN
        (SELECT id, validFrom FROM $competing
            WHERE validFrom > $valid_from
            ORDER BY validFrom ASC LIMIT 1)[0]
    ELSE
        NONE
    END;

    IF $next_after != NONE {
        -- Same sentinel shape as a natural supersede (no retractedAt —
        -- migration 0014; retractionReason 'superseded' feeds revive +
        -- calibration).
        UPDATE $new.id SET
            status = 'superseded',
            retractionReason = 'superseded',
            retractedBy = 'system',
            supersededBy = $next_after.id,
            priorValidUntil = $valid_until,
            validUntil = $next_after.validFrom;
        RETURN {
            outcome: 'INSERTED_HISTORICAL',
            factId: $new.id,
            supersededByFactId: $next_after.id,
            reason: 'backdated'
        };
    };

    LET $scored = SELECT
        id,
        confidence,
        source,
        validFrom,
        object,
        predicate,
        $w_confidence * confidence AS sc_confidence,
        $w_source_trust * fn::source_trust_for(fn::source_key_of(source)) AS sc_source_trust,
        $w_recency * math::pow(math::E, - duration::secs(time::now() - recordedAt) / 31536000) AS sc_recency,
        $w_authority * 0.0 AS sc_authority,
        ($w_confidence * confidence
         + $w_source_trust * fn::source_trust_for(fn::source_key_of(source))
         + $w_recency * math::pow(math::E, - duration::secs(time::now() - recordedAt) / 31536000)
         + $w_authority * 0.0
        ) AS score
    FROM $competing;

    LET $best_opp_score = math::max($scored.score);
    LET $best_opp = (SELECT * FROM $scored WHERE score = $best_opp_score LIMIT 1)[0];

    LET $winner_components = {
        confidence: $w_confidence * $confidence,
        sourceTrust: $w_source_trust * $source_trust,
        recency: $w_recency * 1.0,
        authority: $w_authority * 0.0
    };
    LET $loser_components = {
        confidence: $best_opp.sc_confidence,
        sourceTrust: $best_opp.sc_source_trust,
        recency: $best_opp.sc_recency,
        authority: $best_opp.sc_authority
    };

    LET $abs_conf = math::abs($winner_components.confidence - $loser_components.confidence);
    LET $abs_st   = math::abs($winner_components.sourceTrust - $loser_components.sourceTrust);
    LET $abs_rec  = math::abs($winner_components.recency - $loser_components.recency);
    LET $abs_auth = math::abs($winner_components.authority - $loser_components.authority);
    LET $max_abs  = math::max([$abs_conf, $abs_st, $abs_rec, $abs_auth]);

    LET $dominant_dim = IF $max_abs = $abs_conf THEN 'confidence'
                       ELSE IF $max_abs = $abs_st THEN 'source_trust'
                       ELSE IF $max_abs = $abs_rec THEN 'recency'
                       ELSE 'authority'
                       END;

    LET $slot_delta = {
        predicate: ($best_opp.predicate != $predicate),
        object: ($best_opp.object != $object),
        validFrom: ($best_opp.validFrom != $valid_from),
        source: ($best_opp.source != $source)
    };

    LET $score_breakdown = {
        winner: {
            total: $new_score,
            confidence: $winner_components.confidence,
            sourceTrust: $winner_components.sourceTrust,
            recency: $winner_components.recency,
            authority: $winner_components.authority
        },
        loser: {
            total: $best_opp_score,
            confidence: $loser_components.confidence,
            sourceTrust: $loser_components.sourceTrust,
            recency: $loser_components.recency,
            authority: $loser_components.authority
        },
        margin: $new_score - $best_opp_score
    };

    LET $supersede =
        $semantics = 'single_active'
        OR $new_score >= $best_opp_score + $margin_for_supersede;

    LET $loser_ids = $competing.id;

    IF $supersede {
        -- NO `retractedAt = time::now()` — a natural supersede is not a
        -- retraction (migration 0014). Keep the retractionReason +
        -- retractedBy sentinel that revive + calibration depend on.
        FOR $loser IN $competing {
            UPDATE $loser.id SET
                status = 'superseded',
                retractionReason = 'superseded',
                retractedBy = 'system',
                supersededBy = $new.id,
                priorValidUntil = $loser.validUntil,
                validUntil = $valid_from;
        };
        RETURN {
            outcome: 'SUPERSEDED',
            factId: $new.id,
            supersededFactIds: $loser_ids,
            scoreBreakdown: $score_breakdown,
            dominantDimension: $dominant_dim,
            slotDelta: $slot_delta,
            bestOpponentId: $best_opp.id,
            reason: NONE
        };
    };

    UPDATE $new.id SET status = 'competing';
    UPDATE knowledge_fact SET status = 'competing' WHERE id IN $loser_ids;
    RETURN {
        outcome: 'COMPETING',
        factId: $new.id,
        competingFactIds: $loser_ids,
        scoreBreakdown: $score_breakdown,
        dominantDimension: $dominant_dim,
        slotDelta: $slot_delta,
        bestOpponentId: $best_opp.id,
        reason: NONE
    };
};
