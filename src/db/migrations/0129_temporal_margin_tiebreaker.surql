-- 0129_temporal_margin_tiebreaker — succession tiebreaker for the
-- 'bitemporal' close-margin doctrine (CONFLICT_TEMPORAL_TIEBREAKER).
--
-- THE REGRESSION (memory-fitness run mfmtqn2jiq, 28/30 → 23/30): #444
-- (CONFLICT_MENTION_FACT_SLOT) promotes mention-path single_active
-- writes into this fn's 'bitemporal' margin doctrine and #455 opens the
-- promoted slots' cosine gate (per-call floor −1). Batch-shaped corpora
-- give every write the same confidence/trust/authority, so margins sit
-- at ~0 and EVERY same-slot pairing lands COMPETING — including genuine
-- temporal UPDATES. Measured on the stand: (ledger-sync, status)
-- "now NATS JetStream" (validFrom 2026-03-18, the corpus's own
-- update of the 2026-03-02 Redis Streams decision) ended COMPETING,
-- flipped by the next same-day slot write; honest serving then
-- abstains/names-both on a settled current value (d1-queue, d1-launch,
-- d8-flag-prefix abstentions).
--
-- WHAT THE DATA DISTINGUISHES (measured before building — the naive
-- separations all FAIL on live rows):
--   * validFrom gap alone cannot discriminate: the s07 lease
--     CONTRADICTION arms (must stay COMPETING) carry diary event dates
--     6 DAYS apart (2026-08-08 vs 2026-08-14), the launch-date UPDATE
--     16 days, the payout-cutoff CONTRADICTION 15 days, and the
--     d1-queue-killing pairing 25 MINUTES — no window separates them.
--   * origin/sourceKey cannot discriminate: every row of a battery
--     shares one recorder origin (fn::origin_key_of collapses to the
--     source key), contradiction pairs included.
--   * The UPDATE-LANGUAGE CUE does discriminate: genuine successions
--     say so — "is now NATS JetStream", "moves from 2026-04-15 to
--     2026-05-06", "instead of Fly.io", "no longer the queue" — while
--     contradiction arms assert states without succession markers
--     ("runs until December 2026" vs "actually ends in September 2026";
--     "actually" disputes the record, it does not narrate succession).
--
-- THE DOCTRINE (0129): for 'bitemporal' semantics only, when the
-- close-margin path would flip the slot to COMPETING but the caller
-- attests the incoming claim carries an explicit succession cue
-- ($update_cue = true, computed TS-side by a deterministic marker
-- regex, mention path only) AND an incumbent's event time is STRICTLY
-- EARLIER than the incoming validFrom by MORE than the ambiguity
-- window ($tiebreak_window_ms, bound from ConflictConfig), that
-- incumbent closes as SUPERSEDED history (the natural-supersede
-- sentinel shape) instead of flipping to COMPETING. Pool members
-- within the window, with identical/missing validFrom, or when the cue
-- is absent, keep the existing close-margin → COMPETING doctrine —
-- partitioned exactly like 0085's F1 (losers close, peers flip).
--
-- F3 EXTENSION (measured on the first acceptance run): 0085's F3
-- re-admitted COMPETING rows to the bitemporal_event pool because a
-- stuck pair was otherwise permanent — the 'active'-only pool made it
-- invisible and every later update INSERTED past it. The promoted
-- 'bitemporal' slots inherit the exact same disease: on memfit-tb-1
-- the pre-existing pair {"package manager is pnpm" ↔ "…queue backend
-- is Redis Streams"} stayed competing forever, no later cue-bearing
-- decided update could close it, and serving kept abstaining on the
-- queue value even though the status chain had healed. An ARMED,
-- cue-bearing 'bitemporal' resolve therefore re-admits the slot's
-- COMPETING rows to its candidate pool (gated on window+cue — every
-- other call sees the byte-identical active-only pool): stuck rows
-- strictly older beyond the window close as history with the rest of
-- the losers, same-stamp/within-window ones stay flipped competing.
--
-- WINDOW DEFAULT = 0 ms (strict inequality), argued from measurement:
-- the ambiguity the window exists to protect is SAME-REPORT claims,
-- and those share the exact event-time stamp (one turn → one
-- timestamp), which strict '<' already keeps COMPETING; while the real
-- update chain the regression killed steps in 25-minute increments
-- inside one diary day, so any window ≥ 25 min re-breaks d1-queue.
-- The task-suggested 24h was measured against both acceptance cases
-- and fails both. The parameter stays TS-bound (no migration to tune)
-- for corpora with coarser event-time noise; clamped in TS.
--
-- ACCEPTANCE SHAPE (both sides):
--   * memory-fitness queue chain: "moves from 2026-04-15 to
--     2026-05-06" (cue, 25 min later) now CLOSES "now NATS JetStream"
--     as history instead of flipping it COMPETING — the exact
--     superseded-chain shape of the last passing run (memfit-ac1,
--     28/30); no competing marker → serving serves the current value.
--   * s07 lease arms: "ends in September 2026" carries NO succession
--     cue → the close-margin → COMPETING doctrine stands untouched.
--   * D6 payout-cutoff and the direct-path pairs: the direct path
--     never computes a cue ($update_cue NONE) → byte-identical
--     (measured constant across the passing and failing runs).
--
-- Flag off (CONFLICT_TEMPORAL_TIEBREAKER=0, default): the TS wrapper
-- passes NEITHER new arg; both land NONE, $tb_fire is false on every
-- path, and the fn is behavior-identical to 0085. Existing 25-arg
-- callers (fn::resolve_facts included, until redefined below) remain
-- valid: trailing option<> args may be omitted at call time (verified
-- against the live 3.2.4).
--
-- fn body is 0085 VERBATIM except the blocks marked `-- 0129:`. The
-- signature grows by two trailing option args (25 → 27), so
-- fn::resolve_facts is redefined below in lockstep.

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
    $predicate_alias: option<string>,
    $slot_similarity: option<float>,
    -- 0129: ambiguity window (ms) for the succession tiebreaker; NONE
    -- (the flag-off / non-mention default) disables the tiebreaker.
    $tiebreak_window_ms: option<number>,
    -- 0129: caller-attested succession cue on the incoming object
    -- (deterministic marker regex, computed TS-side on the mention
    -- path only). Anything but true leaves the doctrine untouched.
    $update_cue: option<bool>
) {
    -- Source key + declared authority (migration 0046): computed up front
    -- because authority now participates in the winner's score, not just
    -- the trust snapshot.
    LET $src_key = fn::source_key_of($source);
    LET $src_authority = fn::source_authority_of($src_key);
    -- 0050: origin identity — the document (or, absent one, the source key).
    LET $origin_key = fn::origin_key_of($source);

    -- 0084: the slot gate — bitemporal_event uses its own (stricter)
    -- cosine threshold when the caller supplies one; every other
    -- semantics keeps the shared threshold untouched.
    LET $eff_similarity = IF $semantics = 'bitemporal_event' THEN
        ($slot_similarity ?? $similarity_threshold)
    ELSE
        $similarity_threshold
    END;

    -- 0083: event-time recency for bitemporal_event — the new row's
    -- recency decays from ITS validFrom exactly like the incumbents'
    -- below, so two rows of one batch derive compare by event date, not
    -- by the shared wall-clock write moment.
    LET $new_recency = IF $semantics = 'bitemporal_event' THEN
        math::pow(math::E, - duration::secs(time::now() - $valid_from) / 31536000)
    ELSE
        1.0
    END;

    LET $new_score =
        $w_confidence * $confidence
        + $w_source_trust * $source_trust
        + $w_recency * $new_recency
        + $w_authority * $src_authority;

    -- 0083: the reject gate covers both bitemporal forms (derived rows
    -- score ~0.65 with the deriver's constants — comfortably above the
    -- 0.30 default, so lifecycle-on derive is not dead-letter-prone).
    IF ($semantics = 'bitemporal' OR $semantics = 'bitemporal_event') AND $new_score < $reject_threshold {
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
      -- 0085 (F3): bitemporal_event re-admits COMPETING rows — a stuck
      -- same-day pair must be closable by the next strictly-later-day
      -- update; 0084's 'active'-only pool left the slot broken forever
      -- (both contested rows invisible, the update inserted plainly).
      -- 0129: the SAME F3 doctrine for an ARMED, cue-bearing
      -- 'bitemporal' resolve — measured live (memfit-tb-1): a competing
      -- pair in a promoted slot was PERMANENT ("package manager is
      -- pnpm" ↔ "…queue backend is Redis Streams" stayed competing
      -- forever, every later update INSERTED past it on an empty pool,
      -- and serving kept abstaining on the queue value). Re-admission
      -- is gated on window+cue, so a flag-off / no-cue / direct-path
      -- call sees the byte-identical active-only pool.
      AND (status = 'active'
           OR (status = 'competing' AND $semantics = 'bitemporal_event')
           OR (status = 'competing' AND $semantics = 'bitemporal'
               AND $tiebreak_window_ms != NONE AND $update_cue = true))
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

    -- 0083: bitemporal_event takes the same similarity+interval-gated
    -- pool as bitemporal (the ELSE branch) — the gate is what keeps
    -- aspect CLASSES from colliding.
    -- 0084: gated on the EFFECTIVE threshold (slot-specific for
    -- bitemporal_event, shared for everything else).
    LET $competing = IF $semantics = 'append_only' THEN
        []
    ELSE IF $semantics = 'single_active' THEN
        $candidates
    ELSE
        (SELECT * FROM $candidates
            WHERE embedding != NONE
              AND vector::similarity::cosine(embedding, $embedding) >= $eff_similarity
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

    -- 0083: the create-returned-NONE fence (V9 phase 0). Every branch
    -- below dereferences $new.id; when the CREATE evaluates to NONE the
    -- old body died on the first UPDATE with "Cannot execute UPDATE
    -- statement using value: NONE" and took the whole fn::resolve_facts
    -- batch (= one conversation of derive) with it. Fail the ROW, keep
    -- the batch.
    IF $new = NONE OR $new.id = NONE {
        CREATE ingest_dead_letter CONTENT {
            payload: { entityId: $entity_id, predicate: $predicate, object: $object, source: $source },
            reason: 'create_returned_none'
        };
        RETURN { outcome: 'REJECTED', factId: NONE, reason: 'create_returned_none' };
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
            -- the union and the count unchanged.
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

    -- Backdated guard (migration 0043): a candidate with a STRICTLY NEWER
    -- validFrom means the incoming fact is history. Slot it before the
    -- next-newer decision as an already-superseded row; the active
    -- timeline stays exactly as if events had arrived in order.
    -- 0083: extended to bitemporal_event — its pool is similarity+interval
    -- gated, so "history of the same claim" is exactly what a newer
    -- candidate there means (a re-derived old session must not pollute
    -- current-value reads).
    -- 0084: bitemporal_event compares at DAY granularity — a same-day
    -- incumbent with a later time-of-day must not turn the incoming row
    -- into history (the event data carries day precision only).
    LET $next_after = IF $semantics = 'single_active' THEN
        (SELECT id, validFrom FROM $competing
            WHERE validFrom > $valid_from
            ORDER BY validFrom ASC LIMIT 1)[0]
    ELSE IF $semantics = 'bitemporal_event' THEN
        (SELECT id, validFrom FROM $competing
            WHERE time::floor(validFrom, 1d) > time::floor($valid_from, 1d)
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
        -- 0083: incumbents decay from validFrom under bitemporal_event
        -- (event-time recency); every other semantics keeps recordedAt.
        $w_recency * math::pow(math::E, - duration::secs(time::now() - (IF $semantics = 'bitemporal_event' THEN validFrom ELSE recordedAt END)) / 31536000) AS sc_recency,
        $w_authority * fn::source_authority_of(fn::source_key_of(source)) AS sc_authority,
        ($w_confidence * confidence
         + $w_source_trust * fn::source_trust_scoped(fn::source_key_of(source), $predicate)
         + $w_recency * math::pow(math::E, - duration::secs(time::now() - (IF $semantics = 'bitemporal_event' THEN validFrom ELSE recordedAt END)) / 31536000)
         + $w_authority * fn::source_authority_of(fn::source_key_of(source))
        ) AS score
    FROM $competing;

    LET $best_opp_score = math::max($scored.score);
    LET $best_opp = (SELECT * FROM $scored WHERE score = $best_opp_score LIMIT 1)[0];

    LET $winner_components = {
        confidence: $w_confidence * $confidence,
        sourceTrust: $w_source_trust * $source_trust,
        -- 0083: honest breakdown — the winner's recency term is the
        -- event-time value actually used in $new_score.
        recency: $w_recency * $new_recency,
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

    -- 0129: the succession tiebreaker. Armed ONLY when (a) semantics is
    -- 'bitemporal' (the promoted-slot / open-slot margin doctrine —
    -- bitemporal_event has its own event-order doctrine above, and
    -- single_active supersedes unconditionally), (b) the margin did NOT
    -- already produce a clear winner (a clear winner keeps today's
    -- pool-wide close), (c) the caller bound an ambiguity window, and
    -- (d) the caller attested a succession cue on the incoming object.
    -- Losers are the pool members whose event time is strictly earlier
    -- than the incoming validFrom by MORE than the window; everyone
    -- else (same report moment, within-window, missing validFrom) keeps
    -- the close-margin → COMPETING flip, 0085-F1-partition style.
    LET $margin_win = $semantics != 'bitemporal_event'
        AND $new_score >= $best_opp_score + $margin_for_supersede;
    LET $tb_losers = IF $semantics = 'bitemporal'
        AND $margin_win = false
        AND $tiebreak_window_ms != NONE
        AND $update_cue = true
    THEN
        (SELECT * FROM $competing
            WHERE validFrom != NONE
              AND validFrom + duration::from_millis(<int> $tiebreak_window_ms) < $valid_from)
    ELSE
        []
    END;
    LET $tb_fire = array::len($tb_losers) > 0;

    -- 0083: bitemporal_event supersedes by EVENT ORDER — a strictly
    -- later validFrom is a knowledge update and wins decisively (the
    -- score margin cannot express this: batch derive gives every row
    -- the same confidence/trust/authority, so margins sit near 0 and
    -- recordedAt-scoring left every update COMPETING forever).
    -- 0084: the order is DAY-granular — the event data carries day
    -- precision, so a same-day pair is genuine ambiguity and stays
    -- COMPETING for the contradiction lane (the time-of-day asymmetry
    -- between occurred_on T00:00 and the hh:mm sessionDate fallback
    -- must not fabricate an update).
    -- 0085 (F1): the 0084 decision was PAIRWISE ($best_opp) while the
    -- action was POOL-WIDE. With a multi-row pool (cosine similarity is
    -- not transitive, so two rows each ≥gate to the incoming update can
    -- sit <gate to each other and both stay active) that meant: best_opp
    -- = the earlier row → a SAME-DAY paraphrase closed as history;
    -- best_opp = the same-day row → the strictly-older value silently
    -- flipped to COMPETING instead of closing. bitemporal_event now
    -- PARTITIONS the pool by day and decides per member — event order
    -- is the whole doctrine (0083), and the margin path was declared
    -- unreachable for batch-derived rows by 0084's own rationale, so it
    -- no longer applies to this semantics. Strictly-earlier-DAY members
    -- close; same-day members flip to COMPETING (the backdated guard
    -- already returned for any strictly-later member). The pairwise
    -- day comparison survives only inside $score_breakdown/$slot_delta
    -- reporting.
    -- 0129: when the succession tiebreaker fires, 'bitemporal' takes
    -- the same partitioned shape — beyond-window-older members close,
    -- the rest flip to COMPETING.
    LET $losers = IF $semantics = 'bitemporal_event' THEN
        (SELECT * FROM $competing
            WHERE time::floor(validFrom, 1d) < time::floor($valid_from, 1d))
    ELSE IF $tb_fire THEN
        $tb_losers
    ELSE
        $competing
    END;
    LET $day_peers = IF $semantics = 'bitemporal_event' THEN
        (SELECT * FROM $competing
            WHERE time::floor(validFrom, 1d) >= time::floor($valid_from, 1d))
    ELSE IF $tb_fire THEN
        (SELECT * FROM $competing WHERE id NOT IN $tb_losers.id)
    ELSE
        []
    END;

    LET $supersede =
        $semantics = 'single_active'
        OR ($semantics = 'bitemporal_event' AND array::len($losers) > 0)
        OR ($semantics != 'bitemporal_event' AND $new_score >= $best_opp_score + $margin_for_supersede)
        -- 0129: succession beats a flat margin — the incoming claim
        -- narrates the update of a strictly-earlier state.
        OR $tb_fire;

    LET $loser_ids = $competing.id;

    IF $supersede {
        -- NO `retractedAt = time::now()` — a natural supersede is not a
        -- retraction (migration 0014). Keep the retractionReason +
        -- retractedBy sentinel that revive + calibration depend on.
        FOR $loser IN $losers {
            UPDATE $loser.id SET
                status = 'superseded',
                retractionReason = 'superseded',
                retractedBy = 'system',
                supersededBy = $new.id,
                priorValidUntil = $loser.validUntil,
                validUntil = $valid_from;
        };
        -- 0085 (F1): contested same/later-day members stay OPEN but
        -- flagged — same flip the COMPETING branch applies to losers.
        UPDATE knowledge_fact SET status = 'competing' WHERE id IN $day_peers.id;
        -- Conflict trace (migration 0044): persist the decision the fn just
        -- computed — the fact remembers WHY it won.
        UPDATE $new.id SET conflictTrace = {
            scoreBreakdown: $score_breakdown,
            dominantDimension: $dominant_dim,
            slotDelta: $slot_delta,
            bestOpponentId: $best_opp.id,
            decidedAt: time::now()
        };
        -- 0129: the tiebreak decision is auditable on the winner —
        -- flag-off calls never reach here ($tb_fire false), so the
        -- trace shape is unchanged for them.
        IF $tb_fire {
            UPDATE $new.id SET conflictTrace.temporalTiebreak = {
                windowMs: $tiebreak_window_ms,
                updateCue: true,
                decidedBy: 'event_order'
            };
        };
        RETURN {
            outcome: 'SUPERSEDED',
            factId: $new.id,
            -- 0085: only the members actually closed.
            supersededFactIds: $losers.id,
            competingFactIds: $day_peers.id,
            scoreBreakdown: $score_breakdown,
            dominantDimension: $dominant_dim,
            slotDelta: $slot_delta,
            bestOpponentId: $best_opp.id,
            reason: IF $tb_fire THEN 'temporal_tiebreak' ELSE NONE END
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

-- Batch mapper stays in lockstep with the 27-arg signature (positional
-- contract lives HERE, beside the function it calls — see 0071/0084).
-- $cfg.tiebreak_window_ms / $f.update_cue are absent-tolerant: a caller
-- that never sets them maps to NONE and the tiebreaker stays off — the
-- batch path only carries append_only / bitemporal_event rows today,
-- neither of which the 'bitemporal'-gated tiebreaker can touch.
DEFINE FUNCTION OVERWRITE fn::resolve_facts($facts: array, $cfg: object) {
    RETURN $facts.map(|$f| fn::resolve_fact(
        type::record('knowledge_entity', $f.eid),
        $f.predicate, $f.object, $f.object_meta, $f.embedding,
        $f.confidence, $f.valid_from, $f.valid_until, $f.source,
        $f.source_trust, $f.semantics, $cfg.similarity_threshold,
        $cfg.w_confidence, $cfg.w_source_trust, $cfg.w_recency, $cfg.w_authority,
        $cfg.reject_threshold, $cfg.margin_for_supersede,
        $f.lang, $f.script, $f.entropy, $f.user_id, $f.derived_version,
        $f.predicate_alias, $cfg.slot_similarity,
        $cfg.tiebreak_window_ms, $f.update_cue
    ));
};
