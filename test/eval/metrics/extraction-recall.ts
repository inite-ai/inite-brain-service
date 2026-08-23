import type { ExtractionResult } from '../../../src/eval/types';

/**
 * Extraction predicate-recall — share of expected predicates that the
 * LLM actually surfaced. Returns null when no extraction events occurred,
 * so verticals without mention-style scenarios aren't falsely penalized.
 */
export function extractionRecall(results: ExtractionResult[]): number | null {
  if (results.length === 0) return null;
  return results.reduce((acc, r) => acc + r.predicateRecall, 0) / results.length;
}

/**
 * Entity-extraction success rate — share of mentions where at least the
 * minimum expected number of entities was produced. Null when no
 * extractions ran.
 */
export function entityExtractionRate(results: ExtractionResult[]): number | null {
  if (results.length === 0) return null;
  const ok = results.filter((r) => r.entitiesObserved >= r.minEntities).length;
  return ok / results.length;
}
