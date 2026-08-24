-- 0098: strategy_memory tool trajectories + verified outcomes — the
-- experience-memory extension of G4 (bet #3, Part 3 of
-- docs/roadmap/measurable-economics-mri-2026-08.md). G4 today stores a
-- distilled ADVICE STRING per worked/failed strategy; this adds the
-- agent's *experience* — the concrete tool path it took and whether the
-- outcome was verified.
--
-- ADDITIVE + OPTIONAL by construction: every column is option<...>, so
-- existing rows are unaffected and NO backfill is needed. A write that
-- omits these fields stores nothing for them (verified on SurrealDB
-- 3.2.4: an existing-shape CREATE leaves all three NONE; a SELECT of the
-- new columns on a pre-0098 row returns NONE, never an error). The whole
-- feature is gated OFF by STRATEGY_TRAJECTORIES_ENABLED at the service
-- layer — flag off ⇒ these columns are never written and never selected,
-- so serving is byte-identical to pre-0098.
--
-- COGNITIVE-TRAP CAVEAT (MemTrap work, §Part 3): a trajectory-bearing
-- item is MORE exposed to Cognitive-Bias / Trauma fixation than the bare
-- advice string — it carries a concrete past path that can misfire on a
-- surface-similar new task. Enabling this must ride the §4.3
-- lens-suppression governor + the verifier answer-integrity arm. The
-- trajectory stays ADVISORY: it is rendered for the GENERATOR only and
-- never enters the verifier bundle or citations (the G4 verifier-parity
-- exception is INVIOLABLE — a trajectory is advice, not evidence).
--
-- Element shape (typed subfields, NOT a FLEXIBLE object array): SurrealDB
-- 3.x rejects `FLEXIBLE`-typed elements under an `option<array>` parent
-- (see 0016's note), but a fixed-shape element with explicitly typed
-- subfields applies cleanly and preserves every key. argsDigest /
-- resultDigest are SHORT ONE-WAY DIGESTS of the sanitized payload, never
-- the raw tool args/results — no secrets or PII are stored verbatim (see
-- src/strategy/trajectory-digest.ts).

-- Ordered tool steps: [{tool, argsDigest, resultDigest, ok}].
DEFINE FIELD IF NOT EXISTS trajectory ON strategy_memory TYPE option<array<object>>;
DEFINE FIELD IF NOT EXISTS trajectory[*].tool ON strategy_memory TYPE string;
DEFINE FIELD IF NOT EXISTS trajectory[*].argsDigest ON strategy_memory TYPE string;
DEFINE FIELD IF NOT EXISTS trajectory[*].resultDigest ON strategy_memory TYPE string;
DEFINE FIELD IF NOT EXISTS trajectory[*].ok ON strategy_memory TYPE bool;

-- Verified end-of-run outcome. ASSERT permits NONE (0052 idiom) so the
-- option column is truly optional; a bogus value is rejected at write.
DEFINE FIELD IF NOT EXISTS verifiedOutcome ON strategy_memory TYPE option<string>
  ASSERT $value = NONE OR $value INSIDE ['success', 'failure', 'unknown'];

-- Opaque reference to the evidence that verified the outcome (a run id /
-- eval-record pointer) — provenance only, never a payload.
DEFINE FIELD IF NOT EXISTS outcomeEvidenceRef ON strategy_memory TYPE option<string>;
