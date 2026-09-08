/**
 * The memory-value promotion gate (SCENES_VALUE_GATE_ENABLED, default
 * off) — the first real consumer of the scene VALUE VECTOR.
 *
 * THE DEBT THIS PAYS. The 0106 value vector (novelty, contradiction,
 * stateChange, identity, explicitness, estimatedUtility) has had two
 * producers for a while — the composer's deterministic scorer
 * (`scoreSceneDeterministic`, scene-segmentation.ts) and, under
 * SCENES_PREDICTION_BASELINE, the MEASURED `scene-scorer-v1`
 * (`scorePredictionError`, scene-prediction-baseline.ts) landing in
 * `enrichedMemoryValue` — and exactly ONE reader: `explicitness`, folded
 * into belief confidence by the promotion pass. Five of six dimensions
 * were a write nothing read.
 *
 * WHERE THE VECTOR BECOMES A DECISION. Belief promotion is the one place
 * in the stack where "how much does this scene matter" is not a label but
 * a choice: whether the scene's stateDeltas are allowed to change the
 * world model. A scene whose measured `contradiction` is high is exactly
 * the scene whose deltas MOST deserve promotion — it disagrees with what
 * the system already believes. A scene with near-zero novelty, no
 * contradiction and no state change is noise wearing a delta.
 *
 * THE ASYMMETRY IS THE POLICY: "promote unless demonstrably NOISE", never
 * "promote only if demonstrably VALUABLE". A scene is refused ONLY when
 * all three gated dimensions are PRESENT and every one of them sits below
 * the floor. Consequences, all deliberate:
 *   - an UNSCORED world (pack-projection scenes, legacy rows, enrichment
 *     switched off) promotes EXACTLY as it does with the gate off — the
 *     gate cannot silently empty a belief plane it has no measurements
 *     for;
 *   - one high dimension is enough. The gate never asks a scene to be
 *     valuable on every axis, only to be non-zero on one of them.
 *
 * UNDEFINED IS NOT ZERO — the read-side half of the rule #473 established
 * on the write side. `scorePredictionError` leaves a dimension it cannot
 * measure UNDEFINED and `mergePredictionError` refuses to overwrite the
 * model's guess with a confident 0, precisely because an unknown baseline
 * is not a confident "no contradiction". Reading that same silence back
 * as 0 here would undo it and skip the scene. So a missing dimension
 * short-circuits to PROMOTE, and that is pinned by its own test.
 *
 * WHICH THREE, AND WHY NOT THE OTHER THREE.
 *   - `novelty`       — measured at compose time: 1 − max cosine to the
 *                       prior scene centroids (embeddings, no LLM).
 *   - `contradiction` — measured by scene-scorer-v1 against the stamped
 *                       expectation snapshot; the model's guess otherwise.
 *   - `stateChange`   — measured by scene-scorer-v1: durable transitions
 *                       per member turn, saturating.
 * The three left out are left out on purpose. `explicitness` is already
 * spoken for — it IS the confidence signal the fold folds, so gating on
 * it would apply one number twice. `identity` answers "about whom", not
 * "worth remembering". `estimatedUtility` is the model's self-report of
 * the very question the gate decides, with no measured producer anywhere
 * — gating on it would be circular, an LLM voting on its own admission.
 *
 * PURE BY CONSTRUCTION: no env read (the flag and the floor are resolved
 * ONCE per run in the service, the Drift-3 contract), no db, no clock.
 */

/** The three dimensions the gate reads. Ordered for stable log lines. */
export const VALUE_GATE_DIMS = ['novelty', 'contradiction', 'stateChange'] as const;

export type ValueGateDim = (typeof VALUE_GATE_DIMS)[number];

/** The gated slice of the value vector; every dimension optional. */
export type SceneValueVector = { [K in ValueGateDim]?: number };

/**
 * The scene head as the gate sees it — the projected value dimensions,
 * `unknown` because they come straight off a FLEXIBLE column. Structural
 * on purpose: the gate does not import the promotion pass's row type (and
 * so cannot drag a module cycle in behind it).
 */
export type SceneValueSource = { [K in ValueGateDim]?: unknown };

export interface SceneValueVerdict {
  /** false = demonstrably noise; the scene's deltas are dropped. */
  promote: boolean;
  /**
   *  - `undetermined` — at least one gated dimension is missing, so noise
   *    was never demonstrated. Promotes. This is the unscored world.
   *  - `above-floor`  — every dimension present, at least one >= floor.
   *  - `below-floor`  — every dimension present, ALL below floor. The one
   *    verdict that refuses a scene.
   */
  reason: 'undetermined' | 'above-floor' | 'below-floor';
  /** The dimensions as read (undefined where absent) — for the log line. */
  dims: SceneValueVector;
}

/** Pure: a dimension is present only as a FINITE number. */
function dimension(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** Pure: the gated slice of one scene's value vector. */
export function readSceneValueVector(scene: SceneValueSource): SceneValueVector {
  const dims: SceneValueVector = {};
  for (const dim of VALUE_GATE_DIMS) {
    const value = dimension(scene[dim]);
    if (value !== undefined) dims[dim] = value;
  }
  return dims;
}

/**
 * Pure: the gate's verdict for ONE scene at a resolved floor.
 *
 * A floor of 0 makes the gate a no-op (every present dimension is >= 0) —
 * the documented way to switch the flag on and watch the counters before
 * committing to a threshold.
 */
export function sceneValueVerdict(scene: SceneValueSource, min: number): SceneValueVerdict {
  const dims = readSceneValueVector(scene);
  const present: number[] = [];
  for (const dim of VALUE_GATE_DIMS) {
    const value = dims[dim];
    // UNDEFINED IS NOT ZERO: an unmeasured dimension cannot demonstrate
    // noise, so the scene promotes without the other two being consulted.
    if (value === undefined) return { promote: true, reason: 'undetermined', dims };
    present.push(value);
  }
  if (present.some((value) => value >= min)) {
    return { promote: true, reason: 'above-floor', dims };
  }
  return { promote: false, reason: 'below-floor', dims };
}

/** Pure: the gated dimensions as one stable, greppable log fragment. */
export function formatValueDims(dims: SceneValueVector): string {
  return VALUE_GATE_DIMS.map((dim) => `${dim}=${dims[dim] ?? '?'}`).join(' ');
}
