import { envFlagNotDisabled } from './env-validation';

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
 * runtime-mutable (no restart). Default on (production's setting); `0`
 * makes every writer a guarded no-op and the cron return immediately.
 */
export function outcomeTelemetryEnabled(): boolean {
  return envFlagNotDisabled(process.env.OUTCOME_TELEMETRY_ENABLED);
}

/**
 * Outcome telemetry `retrieved` stream gate — OUTCOME_RETRIEVED_EVENTS.
 *
 * An EXTRA gate on top of the master flag for the one writer whose
 * volume is unbounded by anything smaller than search traffic itself:
 * one event per surfaced fact per search (same id list fact_usage
 * stamps). The env read lives here in the common layer, NOT inside the
 * engine dirs (engine-gates S5.2). Read at call time so a flip is
 * runtime-mutable. Default on (production's setting); `0` keeps searches
 * from writing `retrieved` rows while the low-volume writers go on.
 */
export function outcomeRetrievedEventsEnabled(): boolean {
  return envFlagNotDisabled(process.env.OUTCOME_RETRIEVED_EVENTS);
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
 * flip is runtime-mutable.
 *
 * DEFAULT ON, now that there is somewhere to read it
 * (GET /v1/admin/memory/decisions). It shipped off and stayed off, which
 * meant the only record of WHY the engine abstained or escalated was
 * written nowhere — and the flags that would be judged by that record
 * had to be judged by a benchmark instead. The rows are content-free by
 * contract, one per decision seam per request, bounded by the nightly
 * prune. Set `OUTCOME_DECISION_CAPTURE=0` and no decision row is written
 * and no join column is stamped — serving byte-identical.
 */
export function outcomeDecisionCaptureEnabled(): boolean {
  return envFlagNotDisabled(process.env.OUTCOME_DECISION_CAPTURE);
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
