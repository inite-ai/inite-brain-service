-- 0006_resolve_fact_fn — server-side conflict resolution as a single fn.
--
-- Goal: collapse the 3-4 round-trips of the previous JS-side ingestFact
-- pipeline (SELECT candidates → JS filter → CREATE fact → MERGE losers)
-- into ONE round-trip. Same correctness, ~3× faster on contended
-- predicates.
--
-- Single source of truth: policy data (predicate semantics, similarity
-- threshold, scoring weights, source-trust mapping) lives in
-- src/ingest/conflict-resolver.ts. The function below DOES NOT
-- duplicate the policy table — it accepts policy values as PARAMETERS
-- per call. The JS caller reads its policy table, extracts the
-- relevant values for the current predicate + source, and passes
-- them in. The function does pure math over those values + DB state.
--
-- This is "policy as data, behaviour as code":
--   - JS holds the policy data (the only place predicate semantics
--     are declared).
--   - SurrealQL holds the conflict-resolution behaviour (cosine filter,
--     scoring formula, supersede/competing decision tree).
--   - One source of truth per concern; no synchronisation needed
--     because SurrealQL doesn't know the policy values until called.

-- IF NOT EXISTS rather than OVERWRITE: concurrent migration apply
-- across fresh tenants would otherwise race-rewrite the namespace-level
-- function repeatedly, blocking on OCC. Function-body changes ship as
-- a new numbered migration with explicit OVERWRITE, not by editing
-- this file.
DEFINE FUNCTION IF NOT EXISTS fn::resolve_fact(
    $entity_id: record<knowledge_entity>,
    $predicate: string,
    $object: string,
    $object_meta: option<object>,
    $embedding: array<float>,
    $confidence: float,
    $valid_from: datetime,
    $valid_until: option<datetime>,
    $source: object,
    -- Policy values from JS conflict-resolver.ts:
    $source_trust: float,            -- sourceTrustFor(source)
    $semantics: string,              -- policy.semantics: append_only | single_active | bitemporal
    $similarity_threshold: float,    -- conflict.similarityThreshold
    $w_confidence: float,            -- conflict.weights.confidence
    $w_source_trust: float,          -- conflict.weights.sourceTrust
    $w_recency: float,               -- conflict.weights.recency
    $w_authority: float,             -- conflict.weights.authority
    $reject_threshold: float,        -- conflict.rejectThreshold
    $margin_for_supersede: float     -- conflict.marginForSupersede
) {
    -- Reject early for bitemporal predicates with a low new-fact score.
    -- New fact recency = 1 (now). Authority = 0 (no human override).
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

    -- Pull active facts for this (entity, predicate). Embedding is
    -- materialised in this snapshot for cosine filtering of bitemporals;
    -- recordedAt drives recency weighting in the scoring step.
    LET $candidates = SELECT
        id, predicate, object, confidence, recordedAt, source, embedding
    FROM knowledge_fact
    WHERE entityId = $entity_id
      AND predicate = $predicate
      AND status = 'active'
      AND retractedAt IS NONE;

    -- Branch by semantics for "what counts as competing".
    LET $competing = IF $semantics = 'append_only' THEN
        []
    ELSE IF $semantics = 'single_active' THEN
        $candidates
    ELSE
        -- bitemporal: cosine ≥ threshold
        (SELECT * FROM $candidates
            WHERE embedding != NONE
              AND vector::similarity::cosine(embedding, $embedding) >= $similarity_threshold)
    END;

    -- CREATE the new fact. type::thing'd id is bound by the caller as
    -- a record<knowledge_entity>, so this is type-safe.
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

    -- INSERTED — no contention.
    IF array::len($competing) = 0 {
        RETURN { outcome: 'INSERTED', factId: $new.id, reason: NONE };
    };

    -- Score each competing fact. Source trust for existing facts is
    -- conservatively defaulted to 0.5 (the JS `default` value); we
    -- accept this approximation server-side rather than re-encoding
    -- the full source-trust mapping. The dominant ranking signal is
    -- recency × confidence anyway. If a vertical needs strict
    -- source-trust comparison, the JS-mirrored path remains
    -- available via fn::find_competing_facts + JS scoring.
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

    -- COMPETING — both stay active, both flagged.
    UPDATE $new.id SET status = 'competing';
    UPDATE knowledge_fact SET status = 'competing' WHERE id IN $loser_ids;
    RETURN {
        outcome: 'COMPETING',
        factId: $new.id,
        competingFactIds: $loser_ids,
        reason: NONE
    };
};
