/**
 * SYNTHESIZE_LANES_DISABLED — per-lane ablation switch for the typed
 * answer dispatcher (docs/roadmap/typed-answer-dispatch-2026-07.md).
 * Comma-separated tokens, each a lane number (t1..t6) or its name;
 * every listed lane behaves as if it was never built while the rest of
 * the dispatcher stays live. Exists for one-variable-per-leg eval
 * ablations (e.g. isolating T3 vs T5 blame in a knowledge-update
 * residual); the all-or-nothing SYNTHESIZE_ANSWER_ROUTER_ENABLED can't
 * isolate a single lane.
 *
 * Pure leaf module (no imports): consumed by both the router and
 * common/env-validation, which the router itself imports — keeping the
 * token table here avoids that cycle (same pattern as process-role.ts).
 */

export type DispatchLane =
  | 'temporal' // T1: compute-then-answer elapsed intervals
  | 'enumeration' // T2: exhaustive-list discipline, chronological facts
  | 'contradiction' // T3: COMPETING-evidence conflict notice
  | 'preference' // T4: stored-preference probe + conditioning
  | 'recency' // T5: newest-fact marker on multi-statement slots
  | 'summary' // T6: staged-narrative frame
  | 'instruction'; // T7: standing-instructions section (unconditional)

export const LANE_TOKENS: Readonly<Record<string, DispatchLane>> = {
  t1: 'temporal',
  temporal: 'temporal',
  t2: 'enumeration',
  enumeration: 'enumeration',
  t3: 'contradiction',
  contradiction: 'contradiction',
  t4: 'preference',
  preference: 'preference',
  t5: 'recency',
  recency: 'recency',
  t6: 'summary',
  summary: 'summary',
  t7: 'instruction',
  instruction: 'instruction',
};

/**
 * Parse the raw env value. Unknown tokens are returned rather than
 * dropped: a typo'd token ("t7", "recensy") would otherwise silently
 * ablate NOTHING and the eval leg would measure the full dispatcher —
 * boot validation turns `unknown` into a refuse-to-start error.
 */
export function parseDisabledLanes(raw: string | undefined): {
  lanes: Set<DispatchLane>;
  unknown: string[];
} {
  const lanes = new Set<DispatchLane>();
  const unknown: string[] = [];
  for (const token of (raw ?? '').split(',')) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    const lane = LANE_TOKENS[t];
    if (lane) lanes.add(lane);
    else unknown.push(token.trim());
  }
  return { lanes, unknown };
}
