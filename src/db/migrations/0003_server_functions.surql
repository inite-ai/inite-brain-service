-- 0003_server_functions — server-side SurrealQL functions to
-- consolidate frequently-issued query patterns into one round-trip.
--
-- Why DEFINE FUNCTION rather than canned SurrealQL strings on the
-- client: each top-level `db.query()` call is its own evaluation
-- context with its own latency overhead (one WebSocket frame per
-- statement set). For the conflict-resolution path of ingestFact
-- we issue one SELECT (candidate set) followed by one CREATE +
-- optional MERGE chain. Hoisting the SELECT into a server-side
-- function lets the caller invoke it as a single expression and
-- — more importantly — keeps the candidate-fetch logic in one
-- place if predicate-policy semantics shift.
--
-- We deliberately keep the *scoring decision* on the JS side:
-- the weighted score formula reads predicate policies that live
-- in app code (conflict-resolver.ts) and would otherwise have to
-- be mirrored as SurrealQL hardcoded values. Splitting at the
-- "fetch candidates" boundary is the cleanest seam — the function
-- does pure, deterministic, schema-aware filtering, and JS owns
-- the policy interpretation.

DEFINE FUNCTION IF NOT EXISTS fn::find_competing_facts(
    $entity_id: record<knowledge_entity>,
    $predicate: string
) {
    RETURN SELECT id, predicate, object, confidence, recordedAt, source, embedding
    FROM knowledge_fact
    WHERE entityId = $entity_id
      AND predicate = $predicate
      AND status = 'active'
      AND retractedAt IS NONE;
};

-- Profile composition primitive used by the compilation-stage
-- knowledge artifact builder (see /v1/artifacts/customer_profile/...).
-- Centralising the SELECT here means a future schema change (e.g.
-- new fact field surfaces in the artifact) updates one place.
DEFINE FUNCTION IF NOT EXISTS fn::active_facts_for(
    $entity_id: record<knowledge_entity>,
    $as_of: option<datetime>
) {
    RETURN IF $as_of != NONE THEN
        (SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, source, status
         FROM knowledge_fact
         WHERE entityId = $entity_id
           AND recordedAt <= $as_of
           AND (retractedAt IS NONE OR retractedAt > $as_of)
           AND validFrom <= $as_of
           AND (validUntil IS NONE OR validUntil > $as_of)
         ORDER BY recordedAt DESC)
    ELSE
        (SELECT id, predicate, object, confidence, validFrom, validUntil,
                recordedAt, source, status
         FROM knowledge_fact
         WHERE entityId = $entity_id
           AND retractedAt IS NONE
         ORDER BY recordedAt DESC)
    END;
};
