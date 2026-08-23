import type { MemoryAssertionResult } from '../../../src/eval/types';

/**
 * Fraction of memory-lifecycle assertions that passed across the
 * given outcomes. Returns null when the slice has no memory
 * assertions to score — the aggregator surfaces null as "—" in the
 * report and the test harness skips threshold enforcement.
 *
 * Memory assertions are non-negotiable correctness checks (an entity
 * we forgot must NOT be retrievable; a fact we retracted must NOT
 * surface in default search). The aggregator threshold is 1.0 — any
 * failure should block a release.
 */
export function memoryLifecycleCorrectness(results: MemoryAssertionResult[]): number | null {
  if (results.length === 0) return null;
  const passed = results.filter((r) => r.passed).length;
  return passed / results.length;
}
