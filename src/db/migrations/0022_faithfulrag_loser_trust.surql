-- 0022_faithfulrag_loser_trust — wire learned per-source trust into
-- the loser-side score inside fn::resolve_fact.
--
-- Phase 2 of the must-have memory upgrade introduced `source_trust`
-- (migration 0017): a learned, sourceKey-keyed rolling agreement rate
-- backfilled nightly by CalibrationRefitService from the
-- knowledge_fact CHANGEFEED. The lookup helper `fn::source_trust_for`
-- and the writer were both shipped — but the resolver kept the
-- hardcoded `0.5` constant for the loser-side sourceTrust component in
-- the score (see migration 0021, lines 138 and 142).
--
-- Net effect: the nightly job has been writing rates that no one
-- reads. This migration closes that loop.
--
-- Approach:
--
--   1. New helper `fn::source_key_of($source: object)` derives the
--      canonical source key from a knowledge_fact.source object
--      using the same `${vertical}:${recorder|'_'}` convention as
--      CalibrationRefitService.refit() (`calibration-refit.service.ts:120`).
--      Returns `'system_seed'` for unsourced facts so the learned-
--      trust lookup degrades cleanly.
--
--   2. `fn::resolve_fact` is OVERWRITE'd to compute, per competing
--      fact row, `fn::source_trust_for(fn::source_key_of(source))` and
--      use it in BOTH the per-row sc_source_trust score AND the
--      total composite. The winner's `$source_trust` parameter stays
--      caller-supplied so TS-side heuristics (billing > inbox >
--      default — see IngestService.sourceTrustFor) keep working;
--      the asymmetry is intentional. Winner trust encodes "what
--      kind of source is this", loser trust encodes "how well has
--      this source historically won conflicts".
--
--   3. fn::source_trust_for already gates on sampleCount ≥ 8 and
--      returns the neutral 0.5 below that, so brand-new sources
--      behave identically to the pre-0022 hardcoded constant. The
--      change is monotone — sources whose rate stays at 0.5 see no
--      score shift; sources whose rate has drifted up/down get the
--      drift applied.

-- ── source_key derivation ────────────────────────────────────────
DEFINE FUNCTION OVERWRITE fn::source_key_of($source: option<object>) {
    RETURN IF $source IS NONE OR $source.vertical IS NONE THEN
        'system_seed'
    ELSE
        string::concat(
            <string>$source.vertical,
            ':',
            IF $source.recorder IS NONE THEN '_' ELSE <string>$source.recorder END
        )
    END;
};

-- ── Resolver overwrite ───────────────────────────────────────────
-- Diff vs 0021_revive_after_retract: the `$scored` SELECT replaces
-- the hardcoded `0.5` with `fn::source_trust_for(fn::source_key_of(source))`
-- in two slots — the sc_source_trust column and the composite score
-- expression. Every other branch is byte-identical to 0021 so the
-- revive-after-retract priorValidUntil snapshot semantics are
-- preserved.
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
