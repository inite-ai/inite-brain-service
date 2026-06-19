-- 0021_revive_after_retract — properly revive a previously-superseded
-- sibling fact when its superseder is retracted.
--
-- The bug surfaced by the memory-lifecycle eval scenario
-- `memlc.cycle.update-then-retract`:
--
--   t1: ingest status='active'  (validFrom=2026-01-15)
--   t2: ingest status='churned' (validFrom=2026-04-10)
--           → fn::resolve_fact marks the t1 fact:
--               status='superseded',
--               validUntil = $valid_from of t2 fact (2026-04-10),
--               supersededBy = t2_id
--   t3: POST /v1/facts/{t2_id}/retract
--
-- After t3, t1 is still in status='superseded' with the t2-truncated
-- validUntil. Default search excludes `status NOT IN ['superseded']`,
-- so t1 stays hidden — the system has "no current status" for the
-- entity even though semantically t1 is the surviving truth.
--
-- Fix (two halves):
--
--   1. fn::resolve_fact (SurrealDB side, this migration). When
--      marking a candidate superseded, snapshot its prior validUntil
--      into a new field `priorValidUntil`. Without this snapshot the
--      retract path has nothing to restore — the original validUntil
--      was overwritten by the resolver and is otherwise unrecoverable.
--
--   2. FactsService.retract (Nest side, separate commit). After the
--      retracted-fact mark, walk `supersededBy = $factId` and revive
--      each predecessor whose own retractedAt IS NONE:
--         status        = 'active'
--         supersededBy  = NONE
--         validUntil    = priorValidUntil
--         priorValidUntil = NONE
--      Predecessors that were themselves separately retracted (status
--      = 'retracted', retractedAt set) are left alone — they had an
--      independent reason to be hidden.
--
-- The chain behaviour falls out for free: A → superseded by B,
-- B → superseded by C, retract(C) revives B (since B.supersededBy=C);
-- A stays superseded by B because B is now alive again. retract(B)
-- after that would then revive A. Each retract step reverses exactly
-- one supersede edge.

-- ── Schema field ─────────────────────────────────────────────────
-- Snapshotted validUntil from the moment a fact was marked
-- superseded. Set ONLY by fn::resolve_fact when it overwrites
-- validUntil. Cleared by FactsService.retract on revive.
DEFINE FIELD IF NOT EXISTS priorValidUntil ON knowledge_fact
    TYPE option<datetime>;

-- ── Resolver overwrite ───────────────────────────────────────────
-- Identical to 0018_truthful_resolve except:
--   - SUPERSEDED branch first writes priorValidUntil = current
--     validUntil per loser, then overwrites validUntil with the
--     new fact's validFrom. We must do this per-row (not as a
--     bulk UPDATE) so each loser's snapshot reflects its own
--     prior interval, not the bulk SET value.
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
        confidence,
        source,
        validFrom,
        object,
        predicate,
        $w_confidence * confidence AS sc_confidence,
        $w_source_trust * 0.5 AS sc_source_trust,
        $w_recency * math::pow(math::E, - duration::secs(time::now() - recordedAt) / 31536000) AS sc_recency,
        $w_authority * 0.0 AS sc_authority,
        ($w_confidence * confidence
         + $w_source_trust * 0.5
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
        -- Per-row UPDATE so each loser's priorValidUntil snapshot
        -- reflects its OWN prior interval, not a bulk value. A bulk
        -- SET would overwrite every loser's priorValidUntil with the
        -- same arbitrary row's reading.
        FOR $loser IN $competing {
            UPDATE $loser.id SET
                status = 'superseded',
                retractedAt = time::now(),
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
