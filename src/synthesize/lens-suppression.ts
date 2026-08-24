/**
 * Fovea optics — the lens-suppression governor (Optics §4.3).
 *
 * Companion to docs/roadmap/fovea-optics-2026-08.md §4.3, sharpened by the
 * trap-resistance shakedown docs/roadmap/memtrap-shakedown-2026-08.md. §4.3
 * is emphatic that against a strong hybrid-always baseline a POSITIVE router
 * mostly risks regressions (every misroute is a lane holding the gold that
 * never fired); the real lever is PRECISION OF SUPPRESSION — not firing the
 * lanes that inject noise for this query-class. The shakedown named the trap
 * carriers: the instruction and strategy lanes (Task Boundary / Cognitive
 * Bias / Trauma).
 *
 * This module is the pure decision, and nothing else — no DI, no IO, no env.
 * The single chokepoint for ALL lanes is `RetrievalProfile.lanes`
 * (`ReadonlySet<LaneId>`): routeLane iterates the registry restricted to it,
 * every evidence-conditional lane gates via `profile.lanes.has(...)`. So
 * suppression = subtract lanes from that set at ONE point. Because it is
 * set-minus, it is SUBTRACTIVE BY CONSTRUCTION — the output is always a
 * subset of the input; it can never add a lane and never reorder.
 *
 * Degrades gracefully (the §4.3 failure-mode contract): a missed suppression
 * = today's behavior. The floor is that we NEVER empty a non-empty active
 * set — if a class would suppress every active lane we keep the original.
 * The failure mode must be "kept a slightly noisy lane", never "dropped the
 * lane holding the gold".
 */

import type { LaneId } from '../search/retrieval-profile';
import { ALL_LANES } from '../search/retrieval-profile';
import { cosineSimilarity } from '../common/vector-math';

/** One learned class of the suppression model: a query-embedding centroid
 *  (nearest-centroid match) and the LaneIds it hard-suppresses. */
export interface LensSuppressionClass {
  /** The learned class key (a routed LaneId, an ablation-mined cluster
   *  label, or 'default'). */
  classId: string;
  /** The class's query-embedding centroid — cosine-matched to the query. */
  centroid: number[];
  /** LaneIds this class hard-suppresses for its query-class. */
  suppressLanes: readonly LaneId[];
  /** Labeled samples behind the class (the usability gate reads this). */
  sampleCount: number;
}

/** The persisted per-class suppression model (one entry per class). */
export type LensSuppressionModel = readonly LensSuppressionClass[];

/** The governor's decision outcome (telemetry label + control flow):
 *   - suppressed     — a confident class match removed ≥1 active lane; the
 *                      effective set is a strict, non-empty subset.
 *   - no_model       — no usable model → the original set (byte-identical).
 *   - low_confidence — the nearest centroid's cosine is below the floor →
 *                      the original set (uncertain → today's behavior).
 *   - floor_kept     — a confident class match would suppress EVERY active
 *                      lane; the floor keeps the original set (never empty).
 *   - no_op          — a confident class match, but its suppress set is
 *                      disjoint from the active lanes → the original set. */
export type SuppressionOutcome =
  'suppressed' | 'no_model' | 'low_confidence' | 'floor_kept' | 'no_op';

/** The pure governor decision. `effectiveLanes` is the SAME reference as the
 *  input `activeLanes` for every non-'suppressed' outcome (so the caller can
 *  return the original profile object unchanged — byte-identical), and a
 *  fresh strict subset only when `outcome === 'suppressed'`. */
export interface SuppressionDecision {
  effectiveLanes: ReadonlySet<LaneId>;
  outcome: SuppressionOutcome;
  /** Active lanes actually removed (empty unless outcome is 'suppressed'). */
  removed: LaneId[];
  /** The matched class, when a class was confidently matched. */
  classId?: string;
  /** The matched class's cosine to the query, when matched. */
  cosine?: number;
}

const LANE_SET: ReadonlySet<string> = new Set<string>(ALL_LANES);

/** Coerce a stored lane string to a LaneId (drops unknown ids — a stale or
 *  malformed suppress entry can never introduce a routing ADD). */
export function toLaneId(value: unknown): LaneId | null {
  return typeof value === 'string' && LANE_SET.has(value) ? (value as LaneId) : null;
}

/**
 * Whether a loaded model is USABLE — the load-bearing safety predicate that
 * decides adaptive-vs-static (mirrors focus-signal's hasUsableCalibration).
 * Usable iff at least one class was fit from real samples (sampleCount > 0)
 * AND carries a non-empty centroid to match against. An empty model ([]) and
 * a bootstrap model (all sampleCount 0, or centroid-less rows) both return
 * false, so an unconfigured or freshly-bootstrapped tenant falls back to the
 * static lane set and routes byte-identically to today.
 */
export function isUsableModel(model: LensSuppressionModel): boolean {
  return model.some((c) => c.sampleCount > 0 && c.centroid.length > 0);
}

/**
 * The subtractive governor decision. Nearest-centroid over the usable
 * classes (reusing the shared cosine primitive, common/vector-math); below
 * the cosine floor → unchanged (uncertain → today's behavior). Otherwise
 * subtract the matched class's suppress lanes from the active set, with the
 * non-empty floor. SUBTRACTIVE BY CONSTRUCTION: `effectiveLanes ⊆ activeLanes`
 * for every outcome, and equal (same reference) for everything except
 * 'suppressed'.
 */
export function decideSuppression(args: {
  model: LensSuppressionModel;
  queryEmbedding: number[];
  activeLanes: ReadonlySet<LaneId>;
  minCosine: number;
}): SuppressionDecision {
  const { model, queryEmbedding, activeLanes, minCosine } = args;
  if (!isUsableModel(model)) {
    return { effectiveLanes: activeLanes, outcome: 'no_model', removed: [] };
  }
  // Nearest-centroid over the usable classes only. A dimension mismatch — a
  // malformed / truncated centroid, or an empty query embedding — is skipped
  // outright, so it can never be a false nearest match (degrades to
  // low_confidence, never to a wrong suppress).
  let best: { cls: LensSuppressionClass; cosine: number } | undefined;
  for (const cls of model) {
    if (!(cls.sampleCount > 0) || cls.centroid.length === 0) continue;
    if (cls.centroid.length !== queryEmbedding.length) continue;
    const cosine = cosineSimilarity(queryEmbedding, cls.centroid);
    if (!best || cosine > best.cosine) best = { cls, cosine };
  }
  if (!best || best.cosine < minCosine) {
    return {
      effectiveLanes: activeLanes,
      outcome: 'low_confidence',
      removed: [],
      ...(best ? { classId: best.cls.classId, cosine: best.cosine } : {}),
    };
  }
  const suppress = new Set<LaneId>(best.cls.suppressLanes);
  const removed = [...activeLanes].filter((l) => suppress.has(l));
  if (removed.length === 0) {
    // Confident match, but nothing to remove (disjoint / empty suppress set).
    return {
      effectiveLanes: activeLanes,
      outcome: 'no_op',
      removed: [],
      classId: best.cls.classId,
      cosine: best.cosine,
    };
  }
  const reduced = new Set<LaneId>([...activeLanes].filter((l) => !suppress.has(l)));
  if (reduced.size === 0) {
    // The floor: never empty a non-empty active set. A missed suppression is
    // today's behavior; dropping the last lane could drop the gold.
    return {
      effectiveLanes: activeLanes,
      outcome: 'floor_kept',
      removed,
      classId: best.cls.classId,
      cosine: best.cosine,
    };
  }
  return {
    effectiveLanes: reduced,
    outcome: 'suppressed',
    removed,
    classId: best.cls.classId,
    cosine: best.cosine,
  };
}
