import { FocusSignalService } from './focus-signal.service';
import type { SearchHit } from '../search/search.service';
import type { LaneId } from './answer-router';
import type { AbstainAdaptiveGate } from './verdict';
import {
  buildFocusSignal,
  calibratedConfidence,
  hasUsableCalibration,
  queryClassOf,
  type FocusSignal,
  type PerClassCalibration,
} from './focus-signal';

/**
 * The two fovea adaptive-gate resolvers (Optics-2 §4.1 / Optics §4.2),
 * extracted from the synthesize orchestrator (file budget). Semantics
 * unchanged and load-bearing: each returns its gate ONLY when its flag
 * is on AND a USABLE model (a class fit from real labeled samples) is
 * persisted for the tenant; otherwise undefined so the consumer takes
 * its static path — an unconfigured tenant serves byte-identically. The
 * env reads live in the common layer (fovea-flags, via the
 * FocusSignalService statics), never in this engine dir (engine-gates
 * S5.2). A load failure returns undefined (fail-safe to static).
 */

interface AdaptiveGateDeps {
  focusSignal: FocusSignalService | undefined;
  logger: { warn(message: string): void };
}

/**
 * Optics-2 (§4.1) adaptive-L3 inputs: the loaded per-class VERDICT-stage
 * calibration + escalate threshold, or undefined → the static
 * coverage-floor L3 path.
 */
export async function resolveAdaptiveL3(
  deps: AdaptiveGateDeps,
  companyId: string,
): Promise<{ calibration: PerClassCalibration; threshold: number } | undefined> {
  if (!deps.focusSignal || !FocusSignalService.adaptiveL3Enabled()) return undefined;
  try {
    const calibration = await deps.focusSignal.loadCalibration(companyId);
    if (!hasUsableCalibration(calibration)) return undefined;
    return { calibration, threshold: FocusSignalService.adaptiveL3EscalateThreshold() };
  } catch (e) {
    deps.logger.warn(
      `adaptive-L3 calibration load failed; static fallback: ${(e as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Optics §4.2 adaptive-abstention gate: the calibrated PRE-ANSWER
 * {confidence, threshold} for the coverage-abstention decision, computed
 * from the SAME per-fact scores the pre-answer capture used with
 * verdict='none' (fit-shape = apply-shape §4.2) and the loaded
 * PRE-ANSWER calibration; undefined → the static coverage floor.
 * `signal` rides along (structurally invisible to the verdict.ts gate
 * consumer) so the 0119 abstain decision writer reuses the SAME numbers
 * instead of recomputing.
 */
export async function resolveAdaptiveAbstain(
  deps: AdaptiveGateDeps,
  companyId: string,
  args: { results: SearchHit[]; lane: LaneId | null },
): Promise<(AbstainAdaptiveGate & { signal: FocusSignal }) | undefined> {
  if (!deps.focusSignal || !FocusSignalService.adaptiveAbstainEnabled()) return undefined;
  try {
    const calibration = await deps.focusSignal.loadCalibration(companyId, 'preanswer');
    if (!hasUsableCalibration(calibration)) return undefined;
    const factScores = args.results.flatMap((hit) => hit.facts.map((f) => f.score));
    const signal = buildFocusSignal({
      queryClass: queryClassOf(args.lane),
      factScores,
      verifierVerdict: 'none',
    });
    const confidence = calibratedConfidence(calibration, signal);
    return { confidence, threshold: FocusSignalService.adaptiveAbstainThreshold(), signal };
  } catch (e) {
    deps.logger.warn(
      `adaptive-abstain calibration load failed; static fallback: ${(e as Error).message}`,
    );
    return undefined;
  }
}
