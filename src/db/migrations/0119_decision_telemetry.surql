-- 0119_decision_telemetry — decision-context telemetry (memory_decision)
-- + the decisionId join keys on memory_outcome / focus_signal_sample.
--
-- NUMBERING NOTE: 0114-0118 are claimed by in-flight sibling PRs of the
-- same wave; this migration deliberately takes 0119. The migrator applies
-- by numeric order and tracks per-id, so the gap is harmless whether the
-- siblings land before or after this one.
--
-- Part 1 — decision join key on the raw outcome log. Outcome rows written
-- under OUTCOME_DECISION_CAPTURE carry the decisionId of the request's
-- primary decision, so an outcome (used/verified/confirmed) can be joined
-- back to the policy decision that produced it. NONE = legacy / capture-off.
--
-- IDEMPOTENCY (OUTCOME_TX_WRITES) IS NOT AN INDEX — deliberately. The
-- transactional writer dedupes replays via DETERMINISTIC RECORD IDS +
-- INSERT IGNORE (the #92 changefeed idiom: a replayed batch collides on
-- the PRIMARY KEY and no-ops). A UNIQUE index over a new option<string>
-- event-key column would NOT be additive-safe: SurrealDB unique indexes
-- treat NONE as an indexable value, so every pre-existing row (key = NONE)
-- would collide with every other, and a backfill is out of scope. Record
-- ids need no index and no backfill: legacy rows keep their random ids,
-- flag-on rows get `memory_outcome:<sha256-prefix>`.
--
-- Part 2 — memory_decision: one CONTENT-FREE row per policy decision the
-- serving path takes (this PR wires the abstain gate and the L3 escalation
-- trigger; 'lane_route'/'zoom' reserve the audit's other seams). The row
-- carries ids / enums / numbers ONLY — never query text, never fact text,
-- never answer text. That contract (the 0107 rationale verbatim-in-spirit)
-- is what keeps this table outside the PII reconstruction surface, lets
-- the GDPR forget services purge it as a bulk telemetry sweep (via the
-- memory_outcome.decisionId join — decisions carry no subject linkage by
-- design), and lets the 30-day prune run without provenance ceremony.
-- observedState is FLEXIBLE but SHAPED by a whitelist in the writer
-- (shapeDecisionRow): finite signal numbers + a capped queryClass only.
--
-- Part 3 — focus_signal_sample gains the same decisionId join key. 0094
-- is NOT superseded: the admin fit/measure surface stays the sole consumer
-- of samples; new rows merely gain the join column. NO data migration, no
-- backfill — pre-0119 rows stay NONE.
--
-- NO CHANGEFEED and NO DEFINE EVENT — deliberately (the 0107 rationale):
-- mirroring telemetry into audit_event would flood the audit trail, and a
-- DEFINE EVENT on an append-only telemetry table is a write amplifier.

-- Part 1: decision join key on the raw outcome log
DEFINE FIELD IF NOT EXISTS decisionId ON memory_outcome TYPE option<string>;
DEFINE INDEX IF NOT EXISTS memory_outcome_decision_idx ON memory_outcome FIELDS decisionId;

-- Part 2: memory_decision
DEFINE TABLE IF NOT EXISTS memory_decision SCHEMAFULL;

-- decisionId == the record id tail, duplicated as a plain column so the
-- outcome/focus joins are string joins (no record-id parsing).
DEFINE FIELD IF NOT EXISTS decisionId    ON memory_decision TYPE string;
DEFINE FIELD IF NOT EXISTS requestId     ON memory_decision TYPE option<string>;
-- Kept despite the per-tenant DB (the 0094 precedent): cross-tenant
-- aggregation later needs the tenant on the row.
DEFINE FIELD IF NOT EXISTS companyId     ON memory_decision TYPE string;
DEFINE FIELD IF NOT EXISTS decisionKind  ON memory_decision TYPE string
  ASSERT $value INSIDE ['l3_escalation', 'abstain', 'lane_route', 'zoom'];
DEFINE FIELD IF NOT EXISTS policyVersion ON memory_decision TYPE string;
-- FLEXIBLE but contracted: the writer whitelist admits ONLY
-- {topScore, coverageScore, retrievalGap, rawConfidence, candidateCount:
-- finite numbers; queryClass: string ≤64} — everything else is dropped.
DEFINE FIELD IF NOT EXISTS observedState ON memory_decision TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS chosenAction  ON memory_decision TYPE string;
DEFINE FIELD IF NOT EXISTS actionScore   ON memory_decision TYPE option<float>;
-- Reserved contract for future stochastic/bandit policies — no writer
-- stamps it in this PR (no stochastic policy exists).
DEFINE FIELD IF NOT EXISTS propensity    ON memory_decision TYPE option<float>;
DEFINE FIELD IF NOT EXISTS alternatives  ON memory_decision TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS alternatives[*].action ON memory_decision TYPE string;
DEFINE FIELD IF NOT EXISTS alternatives[*].score  ON memory_decision TYPE float;
DEFINE FIELD IF NOT EXISTS costs                  ON memory_decision TYPE option<object>;
DEFINE FIELD IF NOT EXISTS costs.latencyMs        ON memory_decision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS costs.promptTokens     ON memory_decision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS costs.completionTokens ON memory_decision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS costs.toolCalls        ON memory_decision TYPE option<int>;
DEFINE FIELD IF NOT EXISTS createdAt     ON memory_decision TYPE datetime DEFAULT time::now();

-- ALL single-field, ALL non-unique — deliberately. Uniqueness lives in the
-- record id (deterministic, INSERT IGNORE); a unique decisionId index would
-- be redundant, and single-field coverage keeps the delete paths (GDPR
-- join-purge + prune) out of the 3.2.4 compound-planner DELETE no-op class.
DEFINE INDEX IF NOT EXISTS memory_decision_id_idx      ON memory_decision FIELDS decisionId;
DEFINE INDEX IF NOT EXISTS memory_decision_created_idx ON memory_decision FIELDS createdAt;
DEFINE INDEX IF NOT EXISTS memory_decision_request_idx ON memory_decision FIELDS requestId;

-- Part 3: focus-signal join (0094 shape otherwise untouched; no data migration)
DEFINE FIELD IF NOT EXISTS decisionId ON focus_signal_sample TYPE option<string>;
