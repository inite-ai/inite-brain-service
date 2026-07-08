-- 0045_source_trust_scoped — DOMAIN-SCOPED source reputation.
--
-- Source-reputation track, Phase 2 (the core ask). A source is not equally
-- trustworthy everywhere: a broker is authoritative on availability-today
-- and guesswork on investment forecasts. Until now `source_trust` held ONE
-- blended agreementRate per source; this migration scopes it by `domain`.
--
-- `domain` is a GENERIC string. v1 writes the predicate id into it — the
-- axis conflicts actually happen on (the resolver only ever compares
-- same-predicate facts, so the reputation that decides a conflict should
-- be the same-predicate reputation). A later topic layer (grouping
-- predicates via domain packs) reuses the same field with no migration.
--
-- Shape:
--   * source_trust gains `domain option<string>` (+ winCount/lossCount/
--     lastSeenAt observability). Rows with domain NONE are the GLOBAL
--     per-source rate — exactly what pre-0045 rows already are, so the
--     existing data degrades cleanly into the new model.
--   * UNIQUE index moves from (sourceKey) to (sourceKey, domain).
--   * `source_trust_history` — append-only trail written by the nightly
--     refit when a rate moves: the "reputation over time" record. The hot
--     `source_trust` row stays an UPSERT cache (same split as
--     calibration_table's versioned rows vs the in-process hot copy).
--   * fn::source_trust_scoped($key, $domain) — lookup ladder:
--     scoped row (sampleCount>=8) → global row (>=8) → neutral 0.5.
--     fn::source_trust_for stays untouched for compat.
--   * fn::resolve_fact (body 0044 VERBATIM + delta): the loser-side learned
--     trust and the trustSnapshot.learnedTrust go through the scoped
--     lookup. Winner-side stays the caller-supplied static heuristic —
--     the deliberate asymmetry from 0022 ("winner trust encodes what kind
--     of source this is, loser trust encodes how well it has historically
--     won conflicts") is preserved.
--
-- Behavior drift is monotone: only sources with >=8 scoped samples in a
-- predicate shift away from their global rate (the refit must run before
-- any scoped rows exist at all).

DEFINE FIELD IF NOT EXISTS domain ON source_trust TYPE option<string>;
DEFINE FIELD IF NOT EXISTS winCount ON source_trust TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS lossCount ON source_trust TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS lastSeenAt ON source_trust TYPE option<datetime>;

-- (sourceKey) UNIQUE → (sourceKey, domain) UNIQUE. Existing rows have
-- domain NONE (the global row) — still unique per key under the composite.
REMOVE INDEX IF EXISTS source_trust_key_idx ON TABLE source_trust;
DEFINE INDEX IF NOT EXISTS source_trust_scope_idx
    ON source_trust FIELDS sourceKey, domain UNIQUE;

-- Append-only reputation trail. One row per (sourceKey, domain) per
-- nightly refit that MOVED the rate (|Δ| > 0.01) or first observed the
-- scope — "what was this source's reputation over time", queryable without
-- forensics over fact rows.
DEFINE TABLE IF NOT EXISTS source_trust_history SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS sourceKey ON source_trust_history TYPE string;
DEFINE FIELD IF NOT EXISTS domain ON source_trust_history TYPE option<string>;
DEFINE FIELD IF NOT EXISTS agreementRate ON source_trust_history TYPE float
    ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD IF NOT EXISTS sampleCount ON source_trust_history TYPE int;
DEFINE FIELD IF NOT EXISTS recordedAt ON source_trust_history TYPE datetime
    DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS source_trust_history_scope_idx
    ON source_trust_history FIELDS sourceKey, domain;

-- Lookup ladder: scoped (>=8 samples) → global (>=8) → neutral 0.5. The
-- 8-sample bootstrap matches fn::source_trust_for (FaithfulRAG, 0017).
DEFINE FUNCTION OVERWRITE fn::source_trust_scoped($source_key: string, $domain: string) {
    LET $scoped = (SELECT agreementRate, sampleCount FROM source_trust
                   WHERE sourceKey = $source_key AND domain = $domain LIMIT 1)[0];
    IF $scoped IS NOT NONE AND $scoped.sampleCount >= 8 {
        RETURN $scoped.agreementRate;
    };
    LET $global = (SELECT agreementRate, sampleCount FROM source_trust
                   WHERE sourceKey = $source_key AND domain IS NONE LIMIT 1)[0];
    RETURN IF $global IS NONE OR $global.sampleCount < 8 THEN
        0.5
    ELSE
        $global.agreementRate
    END;
};

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

    -- Trust snapshot (migration 0044): what the resolver believes about this
    -- source RIGHT NOW, frozen onto the fact. learnedTrust is read before
    -- any nightly refit can overwrite the source_trust row. Scoped lookup
    -- since migration 0045.
    LET $src_key = fn::source_key_of($source);

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
        status: 'active',
        trustSnapshot: {
            sourceKey: $src_key,
            domain: $predicate,
            declaredTrust: $source_trust,
            learnedTrust: fn::source_trust_scoped($src_key, $predicate),
            calculatedAt: time::now()
        }
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
        $w_source_trust * fn::source_trust_scoped(fn::source_key_of(source), $predicate) AS sc_source_trust,
        $w_recency * math::pow(math::E, - duration::secs(time::now() - recordedAt) / 31536000) AS sc_recency,
        $w_authority * 0.0 AS sc_authority,
        ($w_confidence * confidence
         + $w_source_trust * fn::source_trust_scoped(fn::source_key_of(source), $predicate)
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
        -- Conflict trace (migration 0044): persist the decision the fn just
        -- computed — the fact remembers WHY it won.
        UPDATE $new.id SET conflictTrace = {
            scoreBreakdown: $score_breakdown,
            dominantDimension: $dominant_dim,
            slotDelta: $slot_delta,
            bestOpponentId: $best_opp.id,
            decidedAt: time::now()
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

    UPDATE $new.id SET
        status = 'competing',
        conflictTrace = {
            scoreBreakdown: $score_breakdown,
            dominantDimension: $dominant_dim,
            slotDelta: $slot_delta,
            bestOpponentId: $best_opp.id,
            decidedAt: time::now()
        };
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
