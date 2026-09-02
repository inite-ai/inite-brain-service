import { envFlagEnabled } from './env-validation';

/**
 * Belief serving lane — BELIEFS_SERVING_LANE.
 *
 * When on, the synthesize-side belief lane (BeliefLaneService) retrieves
 * the caller's ACTIVE semantic_belief rows matching the query (BM25 over
 * the 0126 statement index + a brute-cosine dense leg that degrades to
 * empty while the embedding column is write-dead) and renders them as a
 * current-state prompt section for BOTH the generator and the verifier;
 * the generator's strict schema gains `citedBeliefIds`, resolved through
 * the rendered-set fence into belief-arm EvidenceCitations. This repeals
 * the 0120 shadow doctrine ("nothing on the serving path reads this
 * table") BEHIND this default-off flag. The lane fires ONLY for a
 * user-scoped request (dto.userId) — beliefs are single-user rows and an
 * unscoped answer must never blend one user's state in (stricter than
 * the read API's M2M tenant read; see BeliefLaneService). The env read
 * lives here in the common layer, NOT inside the engine dirs
 * (engine-gates S5.2). Read at call time so a flip is runtime-mutable
 * (no restart). Default off ⇒ no query, no section, no schema field —
 * byte-identical prompts and serving. BELIEFS_ family sits off the
 * ENGINE flag budget by design (a substrate serving switch, not an
 * engine fork).
 */
export function beliefServingLaneEnabled(): boolean {
  return envFlagEnabled(process.env.BELIEFS_SERVING_LANE);
}

/**
 * Belief-aware fact damping — BELIEFS_FACT_DAMPING (PR-B; resolver stub
 * shipped with the lane so the config catalog, boot validation and the
 * inconsistent-pair WARN cover the family from day one).
 *
 * When on (AND the serving lane is on — a no-op without the lane's
 * matched beliefs; env-validation warns on the inconsistent pair), the
 * prompt-side damping pass suffixes and demotes fact lines that a
 * matched current belief contradicts. NOTHING reads this resolver yet:
 * the damping module lands in the follow-up PR. Read at call time
 * (runtime-mutable); common layer per engine-gates S5.2. Default off ⇒
 * byte-identical.
 */
export function beliefFactDampingEnabled(): boolean {
  return envFlagEnabled(process.env.BELIEFS_FACT_DAMPING);
}
