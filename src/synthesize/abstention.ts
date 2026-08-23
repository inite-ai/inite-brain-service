import type { SearchHit } from '../search/search.service';

/**
 * Memory-coverage abstention (V9 §4).
 *
 * The abstention ability rewards refusing when memory genuinely has no
 * answer. Today that decision is delegated entirely to the generator's
 * judgment over whatever the retriever returned — and on a large world
 * retrieval ALWAYS returns something, so the generator routinely
 * composes a plausible answer from near-miss evidence instead of
 * declining (the measured BEAM abstention row, ~42%).
 *
 * This module makes the decision quantitative: a question is answerable
 * only when the retrieved evidence CLEARS a coverage floor — the best
 * retrieval score says "this evidence actually matches the question"
 * and enough independent facts survived the guardrails. Below the
 * floor, synthesize returns an explicit not-in-my-memory answer without
 * spending a generator call.
 *
 * Deliberately NOT active in 'answer'/'off' guardrails modes: 'answer'
 * is a caller-level never-abstain contract (QA settings where a best
 * guess strictly beats a refusal), and 'off' bypasses guardrails
 * entirely. The floor applies where abstention is permitted — strict
 * and lenient.
 *
 * Pure module — no DI, no IO, no env.
 */

/**
 * The explicit abstention answer. Must stay recognizable to
 * decline-detection ("don't have" — the same family as the strict-mode
 * grounding sentinel); phrased as a memory statement, not a grounding
 * statement, because the coverage floor fired BEFORE generation — the
 * engine is saying the memory itself has nothing, not that the
 * generator failed to ground.
 */
export const NOT_IN_MEMORY_ANSWER = "I don't have that in my memory.";

export interface CoverageFloors {
  /**
   * Minimum best fact score (the retrieval pipeline's final fused ×
   * decay × confidence product) for the evidence to count as covering
   * the question. 0 disables the score floor.
   */
  minTopScore: number;
  /**
   * Minimum number of facts in the evidence. 0/1 effectively disables
   * the count floor (empty evidence never reaches this check — the
   * no_results path returns first).
   */
  minEvidence: number;
}

export interface CoverageAssessment {
  /** Best per-fact score across the evidence (0 when no facts). */
  topScore: number;
  /** Total facts across all hits. */
  factCount: number;
  /** True when the evidence clears BOTH floors. */
  covered: boolean;
}

/**
 * Assess whether the retrieved evidence covers the question well enough
 * to attempt an answer. Reads the per-fact `score` (the ranking value
 * the caller sorted by) — not `confidence`, which is write-time
 * certainty about the fact itself and says nothing about whether the
 * fact matches THIS question.
 */
export function assessMemoryCoverage(
  hits: readonly SearchHit[],
  floors: CoverageFloors,
): CoverageAssessment {
  let topScore = 0;
  let factCount = 0;
  for (const hit of hits) {
    for (const f of hit.facts) {
      factCount += 1;
      if (typeof f.score === 'number' && f.score > topScore) {
        topScore = f.score;
      }
    }
  }
  const covered = topScore >= floors.minTopScore && factCount >= floors.minEvidence;
  return { topScore, factCount, covered };
}
