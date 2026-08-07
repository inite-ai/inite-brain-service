-- 0082_predicate_alias — canonical alias for coined predicates (W3,
-- engine-architecture-audit-2026-08 finding #2).
--
-- The dialogue tract (EXTRACTOR_DIALOGUE_PROFILE) deliberately keeps
-- the SPECIFIC predicate the extractor coined ("painted", not
-- "hobby") — but that left dedup/corroboration keyed on the raw
-- coinage, so the same claim under two coinages never met. The fix
-- keeps the raw predicate AND stamps the EDC-canonical id into a new
-- `predicateAlias` column at write time (ExtractorRefineService alias
-- pass); resolution keys on the CANONICAL form.
--
--   * knowledge_fact.predicateAlias — option<string>; NONE = the
--     predicate is already canonical (closed vocabulary, registry hit,
--     or a novel coinage that became its own canon). Every existing
--     row reads as NONE, so `predicateAlias ?? predicate` is
--     byte-identical to `predicate` on all pre-0082 data.
--   * fn::resolve_fact gains a 24th arg ($predicate_alias) and keys
--     its candidate set on (predicateAlias ?? predicate) — two
--     coinages of one canon now dedup/corroborate; closed-vocabulary
--     tenants (alias always NONE) keep the exact old key.
--   * Corroboration now also runs for `append_only` semantics, pooled
--     over $candidates (same canonical predicate, scope- and
--     namespace-local) with the EXACT-object + different-origin gate
--     unchanged. append_only used to early-return before the
--     corroboration block ($competing = [] by definition), which is
--     why re-observed open-vocabulary claims piled up as duplicate
--     active rows instead of strengthening the incumbent.
--
-- fn body is 0079 VERBATIM except: the $predicate_alias arg, the
-- canonical-key clause in $candidates, the predicateAlias stamp on the
-- CREATE, and the corroboration pool ($corr_pool, marked `-- 0082:`).
-- Signature grows 23 → 24 args — the TS call site
-- (fact-resolver.service.ts) moves in the same commit.

DEFINE FIELD IF NOT EXISTS predicateAlias ON knowledge_fact TYPE option<string>;

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
    $entropy: option<float>,
    $user_id: option<string>,
    $derived_version: option<string>,
    $predicate_alias: option<string>
) {
    -- Source key + declared authority (migration 0046): computed up front
    -- because authority now participates in the winner's score, not just
    -- the trust snapshot.
    LET $src_key = fn::source_key_of($source);
    LET $src_authority = fn::source_authority_of($src_key);
    -- 0050: origin identity — the document (or, absent one, the source key).
    LET $origin_key = fn::origin_key_of($source);

    LET $new_score =
        $w_confidence * $confidence
        + $w_source_trust * $source_trust
        + $w_recency * 1.0
        + $w_authority * $src_authority;

    IF $semantics = 'bitemporal' AND $new_score < $reject_threshold {
        CREATE ingest_dead_letter CONTENT {
            payload: { entityId: $entity_id, predicate: $predicate, object: $object, source: $source },
            reason: 'low_score: ' + <string>$new_score
        };
        RETURN { outcome: 'REJECTED', factId: NONE, reason: 'low_score' };
    };

    LET $candidates = SELECT
        id, predicate, predicateAlias, object, confidence, recordedAt, source,
        embedding, validFrom, validUntil
    FROM knowledge_fact
    WHERE entityId = $entity_id
      -- 0082: resolution keys on the CANONICAL predicate — a coined
      -- predicate meets every other coinage of the same canon. Rows and
      -- calls without an alias reduce to the old `predicate = $predicate`.
      AND (predicateAlias ?? predicate) = ($predicate_alias ?? $predicate)
      AND status = 'active'
      AND retractedAt IS NONE
      -- 0055: conflict resolution is scope-local. A personal fact only
      -- ever meets facts of the SAME user; a tenant-global fact only
      -- meets tenant-global ones.
      AND (IF $user_id IS NONE THEN userId IS NONE ELSE userId = $user_id END)
      -- 0079: conflict resolution is namespace-local. A derived fact only
      -- ever meets facts of the SAME derivedVersion; a live-world fact
      -- only meets live-world ones — a re-derivation cannot supersede,
      -- compete with, or corroborate the incumbent world.
      AND (IF $derived_version IS NONE THEN derivedVersion IS NONE ELSE derivedVersion = $derived_version END);

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
    -- since migration 0045; declared authority since 0046; originKey since
    -- 0050.
    LET $new = CREATE ONLY knowledge_fact CONTENT {
        entityId: $entity_id,
        predicate: $predicate,
        predicateAlias: $predicate_alias,
        object: $object,
        objectMeta: $object_meta,
        confidence: $confidence,
        validFrom: $valid_from,
        validUntil: $valid_until,
        source: $source,
        embedding: $embedding,
        status: 'active',
        userId: $user_id,
        derivedVersion: $derived_version,
        trustSnapshot: {
            sourceKey: $src_key,
            originKey: $origin_key,
            domain: $predicate,
            declaredTrust: $source_trust,
            learnedTrust: fn::source_trust_scoped($src_key, $predicate),
            authority: $src_authority,
            calculatedAt: time::now()
        }
    };

    -- Corroboration (migration 0047): the SAME claim from a DIFFERENT
    -- source is independent confirmation, not a duel. Keep the new row as
    -- the audit record of the second claim; strengthen the incumbent.
    -- Runs before the backdated guard — claim identity beats date order.
    -- 0050: independence is decided by ORIGIN, not recorder — two indexers
    -- reading one document are the same origin and must not corroborate.
    -- 0082: append_only pools over $candidates ($competing is [] by
    -- definition, which used to make corroboration unreachable for the
    -- open-vocabulary bulk); other semantics keep the $competing pool.
    -- The block moved above the empty-$competing INSERTED return to be
    -- reachable for append_only — when the pool is empty, $corroborated
    -- is NONE and the flow is byte-identical to 0079.
    LET $corr_pool = IF $semantics = 'append_only' THEN $candidates ELSE $competing END;
    LET $corroborated = (SELECT id, recordedAt FROM $corr_pool
        WHERE object = $object
          AND fn::origin_key_of(source) != $origin_key
        ORDER BY recordedAt DESC LIMIT 1)[0];

    IF $corroborated != NONE {
        UPDATE $new.id SET
            status = 'corroborating',
            corroborates = $corroborated.id;
        UPDATE $corroborated.id SET corroboration = {
            -- 0051: count is the number of DISTINCT corroborating origins,
            -- derived from the deduped set — a repeated origin leaves both
            -- the union and the count unchanged. (0050 incremented count
            -- unconditionally, so one source repeating itself could inflate
            -- the read-time γ boost to its cap.)
            count: array::len(array::union(
                IF corroboration IS NONE OR corroboration.originKeys IS NONE THEN [] ELSE corroboration.originKeys END,
                [$origin_key]
            )),
            sourceKeys: array::union(
                IF corroboration IS NONE THEN [] ELSE corroboration.sourceKeys END,
                [$src_key]
            ),
            -- 0050: origin trail alongside the recorder trail. `?? []` shape
            -- kept explicit for pre-0050 accumulators that lack the field.
            originKeys: array::union(
                IF corroboration IS NONE OR corroboration.originKeys IS NONE THEN [] ELSE corroboration.originKeys END,
                [$origin_key]
            ),
            lastAt: time::now()
        };
        RETURN {
            outcome: 'CORROBORATED',
            factId: $new.id,
            corroboratedFactId: $corroborated.id,
            reason: NONE
        };
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
        $w_authority * fn::source_authority_of(fn::source_key_of(source)) AS sc_authority,
        ($w_confidence * confidence
         + $w_source_trust * fn::source_trust_scoped(fn::source_key_of(source), $predicate)
         + $w_recency * math::pow(math::E, - duration::secs(time::now() - recordedAt) / 31536000)
         + $w_authority * fn::source_authority_of(fn::source_key_of(source))
        ) AS score
    FROM $competing;

    LET $best_opp_score = math::max($scored.score);
    LET $best_opp = (SELECT * FROM $scored WHERE score = $best_opp_score LIMIT 1)[0];

    LET $winner_components = {
        confidence: $w_confidence * $confidence,
        sourceTrust: $w_source_trust * $source_trust,
        recency: $w_recency * 1.0,
        authority: $w_authority * $src_authority
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

-- Batch mapper stays in lockstep with the 24-arg signature (positional
-- contract lives HERE, beside the function it calls — see 0071).
DEFINE FUNCTION OVERWRITE fn::resolve_facts($facts: array, $cfg: object) {
    RETURN $facts.map(|$f| fn::resolve_fact(
        type::record('knowledge_entity', $f.eid),
        $f.predicate, $f.object, $f.object_meta, $f.embedding,
        $f.confidence, $f.valid_from, $f.valid_until, $f.source,
        $f.source_trust, $f.semantics, $cfg.similarity_threshold,
        $cfg.w_confidence, $cfg.w_source_trust, $cfg.w_recency, $cfg.w_authority,
        $cfg.reject_threshold, $cfg.margin_for_supersede,
        $f.lang, $f.script, $f.entropy, $f.user_id, $f.derived_version,
        $f.predicate_alias
    ));
};
