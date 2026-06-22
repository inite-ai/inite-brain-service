/**
 * Conformal-style confidence guardrail for the synthesize pipeline.
 *
 * Phase 3.C of the must-have memory upgrade. References:
 *   - Conformal Linguistic Calibration (arXiv:2502.19110, 2025)
 *   - ConU: Conformal Uncertainty in LLMs (arXiv:2407.00499, 2024)
 *
 * The full conformal-prediction machinery gives a (1 - α) coverage
 * guarantee on a calibration set. We adopt the pragmatic form: every
 * SearchHit fact carries a `breakdown.calibratedConfidence` set by the
 * Phase 3.A isotonic map; the guardrail drops facts whose calibrated
 * value is below a configurable floor *before* the generator sees them
 * as citation targets. Facts above the floor remain in the response so
 * the caller can still see them (DecisionLog continues to attribute
 * them — they just don't enter the prompt as ground-truth evidence).
 *
 * Pure module — no DI, no IO. The synthesize service calls
 * `applyConformalGuardrail()` between fact-index construction and
 * the generator call.
 *
 * Naming caveat: this is NOT full conformal prediction — there is no
 * calibration-set coverage guarantee. It is a fixed confidence-threshold
 * filter informed by the conformal/calibration literature above; the
 * "conformal" name is aspirational, kept only to avoid a churny rename.
 */

import type { SearchHit } from '../search/search.types';

export interface ConformalGuardrailConfig {
  /**
   * Minimum calibrated confidence a fact must have to be eligible as
   * a citation target. 0 = guardrail disabled (every fact eligible).
   * Default for the synthesize service is 0 to preserve back-compat;
   * production deployments override via `SYNTHESIZE_MIN_CONFIDENCE`.
   */
  minCalibratedConfidence: number;
}

export interface ConformalGuardrailResult {
  /** Facts that passed the floor. Same SearchHit shape, just filtered. */
  kept: SearchHit[];
  /** Number of individual facts dropped, summed across all entities. */
  droppedCount: number;
}

/**
 * Drop SearchHit facts whose calibrated confidence falls below
 * `cfg.minCalibratedConfidence`. SearchHits that end up with zero
 * remaining facts are removed entirely. Facts without a breakdown fall
 * back to their raw `confidence` for the comparison (both live in the
 * [0,1] confidence space) so an unscored fact can't slip past the floor.
 */
export function applyConformalGuardrail(
  hits: readonly SearchHit[],
  cfg: ConformalGuardrailConfig,
): ConformalGuardrailResult {
  if (cfg.minCalibratedConfidence <= 0) {
    return { kept: [...hits], droppedCount: 0 };
  }
  const floor = cfg.minCalibratedConfidence;
  let droppedCount = 0;
  const kept: SearchHit[] = [];
  for (const hit of hits) {
    const filteredFacts = hit.facts.filter((f) => {
      // Prefer the calibrated confidence; when a fact carries no
      // breakdown (e.g. backfill rows), fall back to its raw confidence
      // rather than passing it through unconditionally — an unscored
      // fact used to bypass the floor entirely, which let low-confidence
      // evidence reach the generator whenever the breakdown was absent.
      const score = f.breakdown?.calibratedConfidence ?? f.confidence;
      if (score >= floor) return true;
      droppedCount += 1;
      return false;
    });
    if (filteredFacts.length === 0) continue;
    kept.push({ ...hit, facts: filteredFacts });
  }
  return { kept, droppedCount };
}
