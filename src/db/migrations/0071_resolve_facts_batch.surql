-- 0071: batched fact resolution — fn::resolve_facts (plural).
--
-- Mention ingest persists a mention's facts one fn::resolve_fact call at a
-- time (N round-trips). This folds the set into ONE round-trip: map the array
-- through fn::resolve_fact, results returned in order. `array::map` executes
-- the function per element with side effects, in order (verified on 3.2.1).
--
-- Scope: the caller (FactResolverService.resolveMany, behind INGEST_BATCH_FACTS)
-- only routes `append_only` facts here — they never supersede and never assert
-- a unique active row, so batching carries NO cross-request race. single_active
-- / bitemporal facts keep the per-fact + KeyedMutex path (their supersede logic
-- needs the cross-request serialization a batch can't give).
--
-- ⚠️ POSITIONAL CONTRACT: the 22-arg fn::resolve_fact call below MUST stay in
-- sync with its definition (latest body: 0055_user_scope.surql). Keeping the
-- positional binding HERE — versioned, beside the function it calls — is
-- deliberate: it stays out of TS, where a signature change would silently
-- bind values to the wrong slot. The TS side passes a typed object array.
DEFINE FUNCTION OVERWRITE fn::resolve_facts($facts: array, $cfg: object) {
    RETURN $facts.map(|$f| fn::resolve_fact(
        type::record('knowledge_entity', $f.eid),
        $f.predicate, $f.object, $f.object_meta, $f.embedding,
        $f.confidence, $f.valid_from, $f.valid_until, $f.source,
        $f.source_trust, $f.semantics, $cfg.similarity_threshold,
        $cfg.w_confidence, $cfg.w_source_trust, $cfg.w_recency, $cfg.w_authority,
        $cfg.reject_threshold, $cfg.margin_for_supersede,
        $f.lang, $f.script, $f.entropy, $f.user_id
    ));
};
