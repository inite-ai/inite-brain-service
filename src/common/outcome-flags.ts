import { envFlagEnabled } from './env-validation';

/**
 * Outcome telemetry (0107) master flag — OUTCOME_TELEMETRY_ENABLED.
 *
 * When on, the writers (search `retrieved`, synthesize selected/used/
 * verifier-supported, ingest contradicted, feedback confirmed/rejected)
 * append rows to memory_outcome and fold counter deltas into
 * memory_outcome_stat, and the nightly prune cron runs. The env read
 * lives here in the common layer, NOT inside the engine dirs
 * (src/search/ and src/synthesize/ take resolved config only —
 * engine-gates S5.2); engine callers reach it via the
 * MemoryOutcomeService static. Read at call time so a flip is
 * runtime-mutable (no restart). Default off ⇒ every writer is a guarded
 * no-op and the cron returns immediately — serving byte-identical.
 */
export function outcomeTelemetryEnabled(): boolean {
  return envFlagEnabled(process.env.OUTCOME_TELEMETRY_ENABLED);
}

/**
 * Outcome telemetry `retrieved` stream gate — OUTCOME_RETRIEVED_EVENTS.
 *
 * An EXTRA gate on top of the master flag for the one writer whose
 * volume is unbounded by anything smaller than search traffic itself:
 * one event per surfaced fact per search (same id list fact_usage
 * stamps). The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default off ⇒ even with the master on, searches
 * write no `retrieved` rows — operators opt into the raw stream
 * separately from the low-volume outcome writers.
 */
export function outcomeRetrievedEventsEnabled(): boolean {
  return envFlagEnabled(process.env.OUTCOME_RETRIEVED_EVENTS);
}

/**
 * Transactional idempotent outcome writes — OUTCOME_TX_WRITES.
 *
 * When on, MemoryOutcomeService takes the atomic branch: deterministic
 * record ids + INSERT IGNORE inside ONE BEGIN/COMMIT (raw append and
 * stat fold land together or not at all), an in-tx pre-select gates the
 * stat deltas so a replayed batch folds NOTHING twice, and an OCC abort
 * gets exactly one immediate retry. The env read lives here in the
 * common layer, NOT inside the engine dirs (engine-gates S5.2). Read at
 * call time so a flip is runtime-mutable. Default off ⇒ the legacy
 * two-statement write path runs BYTE-IDENTICAL (same SQL strings, same
 * params keys — pinned by the unit spec).
 */
export function outcomeTxWritesEnabled(): boolean {
  return envFlagEnabled(process.env.OUTCOME_TX_WRITES);
}

/**
 * Decision-context telemetry — OUTCOME_DECISION_CAPTURE.
 *
 * When on, the synthesize seams write CONTENT-FREE memory_decision rows
 * (0119) at the abstain gate and the L3 escalation trigger, stamp the
 * request's primary decisionId onto outcome rows / focus-signal samples,
 * and the nightly decision prune leg runs. An INDEPENDENT master —
 * deliberately NOT coupled to OUTCOME_TELEMETRY_ENABLED (the
 * TOOL_OBSERVATIONS_ENABLED precedent): decision context is useful with
 * or without the outcome stream. The env read lives here in the common
 * layer, NOT inside the engine dirs (engine-gates S5.2); engine callers
 * reach it via the MemoryDecisionService static. Read at call time so a
 * flip is runtime-mutable. Default off ⇒ no decision row is ever
 * written and no join column is ever stamped — serving byte-identical.
 */
export function outcomeDecisionCaptureEnabled(): boolean {
  return envFlagEnabled(process.env.OUTCOME_DECISION_CAPTURE);
}

/** Default raw-event retention window for the nightly prune (days). */
const DEFAULT_EVENT_RETENTION_DAYS = 30;

/**
 * Raw-event retention window — OUTCOME_EVENT_RETENTION_DAYS.
 *
 * The nightly prune cron deletes memory_outcome rows older than this
 * many days (the rollup table is never pruned — it survives raw-row
 * retention by design, see 0107). A non-boolean knob resolved here in
 * the common layer so consumers take a resolved number. Must be a
 * positive integer; unset, blank, or out of range → the 30-day default.
 */
export function outcomeEventRetentionDays(): number {
  const raw = process.env.OUTCOME_EVENT_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EVENT_RETENTION_DAYS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_EVENT_RETENTION_DAYS;
}

/** Default decision-row retention window for the nightly prune (days). */
const DEFAULT_DECISION_RETENTION_DAYS = 30;

/**
 * Decision-row retention window — OUTCOME_DECISION_RETENTION_DAYS.
 *
 * The nightly prune cron (03:41 UTC, third leg) deletes memory_decision
 * rows older than this many days — decision context is prunable
 * telemetry, like the raw outcome log (0107) and tool observations
 * (0111). A non-boolean knob resolved here in the common layer so
 * consumers take a resolved number. Must be a positive integer; unset,
 * blank, or out of range → the 30-day default.
 */
export function outcomeDecisionRetentionDays(): number {
  const raw = process.env.OUTCOME_DECISION_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DECISION_RETENTION_DAYS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_DECISION_RETENTION_DAYS;
}
