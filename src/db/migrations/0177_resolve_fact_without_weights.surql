-- 0177: write-time resolution decides only what needs no judgement (#830).
--
-- Until now fn::resolve_fact (latest body 0172) settled a new fact against
-- its slot with a hand-set weighted score: confidence, source trust,
-- recency and authority, a 0.15 supersede margin, a 0.30 reject floor, and
-- 0129's word-cue tiebreaker on top. None of those numbers was measured.
-- On the memory-fitness stand a paraphrase ("8081" vs "8081 (internal
-- admin console)") lost on a 0.045 margin and both rows went `competing`.
-- A newer value at a later valid time could lose to an older one extracted
-- with more confidence. A genuine same-time disagreement could vanish
-- because one source scored higher. And since #828 every new fact is judged
-- anyway, by a model that names the relation (same / replaces /
-- contradicts / unrelated) with valid time deciding order, so two
-- mechanisms answered one question and the weighted one ran first.
--
-- Graphiti/Zep (arXiv 2501.13956 §2.2) and Mem0 (arXiv 2504.19413) carry no
-- score margin anywhere. Write-time code keeps what is deterministic, and
-- the model decides the relation. This body keeps:
--   1. the 0165 end of a held value, and corroboration of the same object
--      from another origin (0047/0050), unchanged;
--   2. a restatement of the same object from the same origin corroborates
--      it, for every semantics with a slot. 0129 did this only when its
--      tiebreaker was armed;
--   3. valid-time succession. A strictly later validFrom closes the
--      earlier values of the slot at that instant, and a strictly earlier
--      one goes into history. `single_active` closes every overlapping
--      value as before. `bitemporal_event` keeps its day granularity
--      (0084/0085), deterministic and out of #830's scope;
--   4. `append_only`, unchanged.
-- Everything else, chiefly two values of one slot at the same valid time,
-- is inserted `active` and left to fact resolution (#828), which
-- corroborates a paraphrase, supersedes a successor, or marks a real
-- disagreement `competing`. `COMPETING` is no longer a write-time outcome
-- for `bitemporal`, and no fact is dropped for a low weighted score
-- (`REJECTED low_score` is gone; `create_returned_none` stays).
--
-- Pools admit `competing` rows on every semantics (#830 addendum). A
-- disputed pair must be closable by the next value, whoever wrote it.
-- Before, only `bitemporal_event` and an armed 0129 call re-admitted them,
-- so a competing CRM value outlived every later sync.
--
-- A NEW NAME, fn::settle_fact / fn::settle_facts, not an overwrite: the
-- signature drops the weights, the margin, the reject floor and the
-- tiebreak window/cue, and a stored function's parameters are append-only
-- across a rolling deploy (test/migration-rolling-deploy-doctrine). The
-- image rolling out from still calls fn::resolve_fact with 28 arguments;
-- that body is left exactly as 0172 defined it and is removed one release
-- after no image calls it (expand, then contract). Source trust and authority stay on the fact's
-- trustSnapshot as provenance, not as a vote. conflictTrace records
-- `decidedBy: 'valid_time'` and the facts closed; there is no
-- scoreBreakdown.
--
-- `$circles` now carries every group tag of the write, circle and team.
--
-- fn::fact_has_rival (0175) and the competing_needs_a_rival event are
-- untouched: a write that closes a competing row still settles its rival.

DEFINE FUNCTION OVERWRITE fn::settle_fact(
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
    $slot_similarity: option<float>,
    $lang: option<string>,
    $script: option<string>,
    $entropy: option<float>,
    $user_id: option<string>,
    $derived_version: option<string>,
    $predicate_alias: option<string>,
    $circles: option<array<string>>
) {
    LET $src_key = fn::source_key_of($source);
    LET $src_authority = fn::source_authority_of($src_key);
    LET $origin_key = fn::origin_key_of($source);

    -- 0084: bitemporal_event uses its own (stricter) cosine threshold when
    -- the caller supplies one.
    LET $eff_similarity = IF $semantics = 'bitemporal_event' THEN
        ($slot_similarity ?? $similarity_threshold)
    ELSE
        $similarity_threshold
    END;

    LET $candidates = SELECT
        id, predicate, predicateAlias, object, confidence, recordedAt, source,
        embedding, validFrom, validUntil, status
    FROM knowledge_fact
    WHERE entityId = $entity_id
      -- 0082: the canonical predicate is the slot.
      AND (predicateAlias ?? predicate) = ($predicate_alias ?? $predicate)
      -- #830: a disputed value is closable by the next one.
      AND status IN ['active', 'competing']
      AND retractedAt IS NONE
      -- 0055: a personal fact meets only facts of the same user.
      AND (IF $user_id IS NONE THEN userId IS NONE ELSE userId = $user_id END)
      -- 0172: a fact said in a circle meets only facts of the same circle(s).
      -- #830 extends it to team groups (`team:` tags an org connection writes):
      -- a team's fact must not close, or be closed by, a fact outside the team,
      -- since the closure alone would tell one audience what the other said.
      AND array::sort((scope ?? []).filter(|$t| string::starts_with($t, 'circle:') OR string::starts_with($t, 'team:')))
          = array::sort(($circles ?? []).filter(|$t| string::starts_with($t, 'circle:') OR string::starts_with($t, 'team:')))
      -- 0079: a derived fact meets only facts of the same derivedVersion.
      AND (IF $derived_version IS NONE THEN derivedVersion IS NONE ELSE derivedVersion = $derived_version END);

    LET $slot = IF $semantics = 'append_only' THEN
        []
    ELSE IF $semantics = 'single_active' THEN
        -- 0165: one value at a time, but only at the same time.
        (SELECT * FROM $candidates
            WHERE fn::intervals_overlap(validFrom, validUntil, $valid_from, $valid_until))
    ELSE
        (SELECT * FROM $candidates
            WHERE embedding != NONE
              -- 0138: vector::similarity::cosine aborts on a width mismatch.
              AND array::len(embedding) = array::len($embedding)
              AND vector::similarity::cosine(embedding, $embedding) >= $eff_similarity
              AND fn::intervals_overlap(validFrom, validUntil, $valid_from, $valid_until))
    END;

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

    -- 0083: fail the row, keep the batch.
    IF $new = NONE OR $new.id = NONE {
        CREATE ingest_dead_letter CONTENT {
            payload: { entityId: $entity_id, predicate: $predicate, object: $object, source: $source },
            reason: 'create_returned_none'
        };
        RETURN { outcome: 'REJECTED', factId: NONE, reason: 'create_returned_none' };
    };

    -- 0165: an ended restatement of a held value is that value's end.
    IF $valid_until != NONE {
        LET $ended = (SELECT id, validFrom FROM $candidates
            WHERE validUntil IS NONE
              AND validFrom < $valid_until
              AND fn::same_value(object, $object)
            ORDER BY validFrom DESC LIMIT 1)[0];
        IF $ended != NONE {
            UPDATE $ended.id SET validUntil = $valid_until;
            UPDATE $new.id SET status = 'corroborating', corroborates = $ended.id;
            RETURN { outcome: 'CORROBORATED', factId: $new.id, corroboratedFactId: $ended.id, reason: 'ended' };
        };
    };

    -- 0047/0050/0051: the same claim from another origin confirms it.
    LET $corr_pool = IF $semantics = 'append_only' THEN $candidates ELSE $slot END;
    LET $corroborated = (SELECT id, recordedAt FROM $corr_pool
        WHERE object = $object
          AND fn::origin_key_of(source) != $origin_key
        ORDER BY recordedAt DESC LIMIT 1)[0];
    IF $corroborated != NONE {
        UPDATE $new.id SET status = 'corroborating', corroborates = $corroborated.id;
        UPDATE $corroborated.id SET corroboration = {
            count: array::len(array::union(
                IF corroboration IS NONE OR corroboration.originKeys IS NONE THEN [] ELSE corroboration.originKeys END,
                [$origin_key]
            )),
            sourceKeys: array::union(
                IF corroboration IS NONE THEN [] ELSE corroboration.sourceKeys END,
                [$src_key]
            ),
            originKeys: array::union(
                IF corroboration IS NONE OR corroboration.originKeys IS NONE THEN [] ELSE corroboration.originKeys END,
                [$origin_key]
            ),
            lastAt: time::now()
        };
        RETURN { outcome: 'CORROBORATED', factId: $new.id, corroboratedFactId: $corroborated.id, reason: NONE };
    };

    -- The same object again from the same origin is a restatement: neither
    -- an update nor a dispute, and not an independent confirmation (0051).
    LET $restated = (SELECT id, recordedAt FROM $slot
        WHERE object = $object
          AND fn::origin_key_of(source) = $origin_key
        ORDER BY recordedAt DESC LIMIT 1)[0];
    IF $restated != NONE {
        UPDATE $new.id SET status = 'corroborating', corroborates = $restated.id;
        RETURN { outcome: 'CORROBORATED', factId: $new.id, corroboratedFactId: $restated.id, reason: 'restated' };
    };

    IF array::len($slot) = 0 {
        IF $lang != NONE { UPDATE $new.id SET lang = $lang, script = $script; };
        IF $entropy != NONE { UPDATE $new.id SET extractionEntropy = $entropy; };
        RETURN { outcome: 'INSERTED', factId: $new.id, reason: NONE };
    };

    -- 0043: a value of the slot that starts strictly later makes the
    -- incoming one history. bitemporal_event compares by day (0084).
    LET $next_after = IF $semantics = 'bitemporal_event' THEN
        (SELECT id, validFrom FROM $slot
            WHERE time::floor(validFrom, 1d) > time::floor($valid_from, 1d)
            ORDER BY validFrom ASC LIMIT 1)[0]
    ELSE
        (SELECT id, validFrom FROM $slot
            WHERE validFrom > $valid_from
            ORDER BY validFrom ASC LIMIT 1)[0]
    END;
    IF $next_after != NONE {
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

    -- Valid-time succession. single_active: every overlapping value of the
    -- slot ends here (none starts later — the guard above returned).
    -- bitemporal: the values that started strictly earlier. bitemporal_event:
    -- those of strictly earlier days, same-day peers flip competing (0085).
    LET $closed = IF $semantics = 'single_active' THEN
        $slot
    ELSE IF $semantics = 'bitemporal_event' THEN
        (SELECT * FROM $slot WHERE time::floor(validFrom, 1d) < time::floor($valid_from, 1d))
    ELSE
        (SELECT * FROM $slot WHERE validFrom < $valid_from)
    END;
    LET $day_peers = IF $semantics = 'bitemporal_event' THEN
        (SELECT * FROM $slot WHERE time::floor(validFrom, 1d) >= time::floor($valid_from, 1d))
    ELSE
        []
    END;

    IF array::len($closed) > 0 {
        -- A supersede is not a retraction (0014): no retractedAt.
        FOR $loser IN $closed {
            UPDATE $loser.id SET
                status = 'superseded',
                retractionReason = 'superseded',
                retractedBy = 'system',
                supersededBy = $new.id,
                priorValidUntil = $loser.validUntil,
                validUntil = $valid_from;
        };
        IF array::len($day_peers) > 0 {
            UPDATE knowledge_fact SET status = 'competing' WHERE id IN $day_peers.id;
        };
        UPDATE $new.id SET conflictTrace = {
            decidedBy: 'valid_time',
            supersededFactIds: $closed.id,
            bestOpponentId: $closed[0].id,
            decidedAt: time::now()
        };
        RETURN {
            outcome: 'SUPERSEDED',
            factId: $new.id,
            supersededFactIds: $closed.id,
            competingFactIds: $day_peers.id,
            bestOpponentId: $closed[0].id,
            reason: 'valid_time'
        };
    };

    IF array::len($day_peers) > 0 {
        -- bitemporal_event: a same-day value of the slot is a genuine
        -- ambiguity at the data's precision (0084).
        UPDATE knowledge_fact SET status = 'competing' WHERE id IN $day_peers.id OR id = $new.id;
        UPDATE $new.id SET conflictTrace = {
            decidedBy: 'event_day',
            competingFactIds: $day_peers.id,
            bestOpponentId: $day_peers[0].id,
            decidedAt: time::now()
        };
        RETURN {
            outcome: 'COMPETING',
            factId: $new.id,
            competingFactIds: $day_peers.id,
            bestOpponentId: $day_peers[0].id,
            reason: 'event_day'
        };
    };

    -- Same valid time, another value: what they are to each other is a
    -- judgement. Fact resolution (#828) reads this row next.
    IF $lang != NONE { UPDATE $new.id SET lang = $lang, script = $script; };
    IF $entropy != NONE { UPDATE $new.id SET extractionEntropy = $entropy; };
    RETURN {
        outcome: 'INSERTED',
        factId: $new.id,
        peerFactIds: $slot.id,
        reason: 'for_resolution'
    };
};

DEFINE FUNCTION OVERWRITE fn::settle_facts($facts: array, $cfg: object) {
    RETURN $facts.map(|$f| fn::settle_fact(
        type::record('knowledge_entity', $f.eid),
        $f.predicate, $f.object, $f.object_meta, $f.embedding,
        $f.confidence, $f.valid_from, $f.valid_until, $f.source,
        $f.source_trust, $f.semantics, $cfg.similarity_threshold,
        $cfg.slot_similarity,
        $f.lang, $f.script, $f.entropy, $f.user_id, $f.derived_version,
        $f.predicate_alias, $f.circles
    ));
};

-- Record-door facts carry their door (#830 addendum: a system of record
-- decides its own slot). New commits stamp `source.kind = 'source_record'`
-- (commit-writer); rows committed before this migration get it from their
-- grounding document.
UPDATE knowledge_fact SET source.kind = 'source_record'
    WHERE source.kind IS NONE
      AND source.documentId IS NOT NONE
      AND <string> source.documentId IN (SELECT VALUE <string> id FROM source_document WHERE kind = 'source_record');
