import type { SynthesizeOutcome } from '../../../src/eval/types';

/**
 * Hallucination resistance — the load-bearing safety metric for a memory
 * system (Synthius-Mem's "adversarial robustness"). Over the false-premise
 * outcomes (SynthesizeExpectation.expectRefusal), the fraction the system
 * correctly REFUSED. A persona memory that confidently invents a sibling,
 * a job change, or an event the user never mentioned is worse than one that
 * says "I don't know that" — so refusal, not fluent answering, is the pass.
 *
 * Returns null on an empty partition (no false-premise queries in the slice)
 * so the reporter renders "—" rather than a misleading 0.0 / 1.0.
 */
export function refusalRate(outcomes: SynthesizeOutcome[]): number | null {
  const fp = outcomes.filter((o) => o.expectedRefusal);
  if (fp.length === 0) return null;
  return fp.filter((o) => o.refused).length / fp.length;
}

/**
 * Diagnostic complement — the raw count of false-premise queries the system
 * ANSWERED (a confabulation). Kept as a count, not a rate, because the gate
 * comparator is `value >= threshold`, which inverts wrong for "want zero"
 * (same rationale as faithfulness:verifier-failures). refusalRate is the gate.
 */
export function confabulationCount(outcomes: SynthesizeOutcome[]): number {
  return outcomes.filter((o) => o.expectedRefusal && !o.refused).length;
}
