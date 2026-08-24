import type { PolicyOperatingPoint } from './economics';

/**
 * Part 2 — the Memory Reliability Index (MRI) report shape
 * (docs/roadmap/measurable-economics-mri-2026-08.md §2).
 *
 * THE ONE INVIOLABLE RULE: every dimension cell is either a real value backed
 * by a live source (telemetry / a suite-recorded status) OR the literal
 * `'pending-eval'` string with a `reason`. A dimension that needs the parked
 * paid-accuracy eval renders `'pending-eval'`, never a guess. Structural
 * dimensions may also render `'unrecorded'` (suite present, status not yet
 * captured by a real run) — again with a reason, never a fabricated pass.
 */

/** A dimension cell value: a real number/string, or an honest sentinel. */
export type MriValue = number | string | 'pending-eval';

export interface MriDimension {
  /** Real measured value, or the `'pending-eval'` / `'unrecorded'` sentinel. */
  value: MriValue;
  /** Unit of a numeric value (omitted for sentinels / status strings). */
  unit?: string;
  /** Human-readable provenance: which counter / suite / eval produced this. */
  source: string;
  /** ISO timestamp the value is as-of. */
  asOf: string;
  /** Whether this dimension is blocked on the parked labeled/paid eval. */
  evalGated: boolean;
  /** Required whenever value is a sentinel — why it is not a live number. */
  reason?: string;
  /** How the dimension resolves: 'live' telemetry, 'structural' suite-backed,
   *  or 'pending' (eval-/feature-gated). */
  kind: 'live' | 'structural' | 'pending';
}

/**
 * The bounded, rolling window the LIVE rate cells cover. Prometheus counters are
 * process-lifetime accumulators; the MRI reader deltas them against a baseline
 * snapshot so "per query" rates reflect only recent traffic, never the whole
 * process lifetime. `startedAt`..`endedAt` is what the numbers are as-of.
 */
export interface MriWindow {
  /** Window start — the baseline snapshot the delta is taken against (ISO). */
  startedAt: string;
  /** Window end — the report's generation time (ISO). */
  endedAt: string;
  /** Configured rolling-window bound in milliseconds. */
  windowMs: number;
}

export interface MriReport {
  generatedAt: string;
  /** The seven §2 dimensions plus the split cost/latency cells. */
  dimensions: Record<string, MriDimension>;
  /** Part 1 live operating point (proxy-accuracy × cost × latency). */
  operatingPoint: PolicyOperatingPoint;
  /** The rolling window the LIVE rate cells cover (absent for a pure
   *  buildMriReport call that does not window — e.g. unit tests). */
  window?: MriWindow;
}
