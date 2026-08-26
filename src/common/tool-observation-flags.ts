import { envFlagEnabled } from './env-validation';

/**
 * Tool observation (0111) master flag — TOOL_OBSERVATIONS_ENABLED.
 *
 * When on, the per-request MCP server build applies the observation
 * wrapper (innermost — inside the policy/grant gates, so a denied call
 * records nothing and durationMs times the raw handler), the pack-tool
 * proxy stamps identity-bearing rows around deliver, the ingest path
 * accepts toolObservationRef, and the nightly prune leg runs. The env
 * read lives here in the common layer (engine-gates S5.2) and is read at
 * call time so a flip is runtime-mutable (no restart; the MCP server is
 * rebuilt per request). Default off ⇒ the wrapper is NOT applied, the
 * recorder is a guarded no-op, and the prune leg returns immediately —
 * serving byte-identical.
 */
export function toolObservationsEnabled(): boolean {
  return envFlagEnabled(process.env.TOOL_OBSERVATIONS_ENABLED);
}

/**
 * Content-excerpt opt-in — TOOL_OBSERVATION_CONTENT.
 *
 * An EXTRA gate on top of the master flag for the one column that can
 * carry payload content: contentExcerpt (≤512 chars, sanitized). Default
 * off ⇒ rows are digest-only (content-free by the 0107/0111 contract)
 * and the table stays out of the PII reconstruction surface. Read at
 * call time so a flip is runtime-mutable.
 */
export function toolObservationContentEnabled(): boolean {
  return envFlagEnabled(process.env.TOOL_OBSERVATION_CONTENT);
}

/** Default raw-row retention window for the nightly prune leg (days). */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Raw-row retention window — TOOL_OBSERVATION_RETENTION_DAYS.
 *
 * The nightly 03:41 UTC prune (OutcomePruneService) deletes
 * tool_observation rows older than this many days. A non-boolean knob
 * resolved here in the common layer so consumers take a resolved number.
 * Must be a positive integer; unset, blank, or out of range → the
 * 30-day default.
 */
export function toolObservationRetentionDays(): number {
  const raw = process.env.TOOL_OBSERVATION_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_DAYS;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}
