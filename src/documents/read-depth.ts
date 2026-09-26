import type { TriageStamp } from './triage';

/**
 * How deep a captured text is read (docs/roadmap/raw-processing-triggers-
 * 2026-09.md §4.1–4.2), decided from its D1 triage stamp and what the
 * memory already knows about it. Pure — no DB, no LLM.
 *
 *  - `raw`: kept as raw turns only (D0/D1). Still served — every raw lane
 *    reads it — and read in full the moment something needs it (an
 *    answer cites it, a correction lands next to it: promotion).
 *  - `single`: one extraction sample (D2a).
 *  - `full`: the self-consistency samples (D2b) — the configured default.
 *
 * Asymmetric by construction: only a text the triage found to be noise on
 * EVERY question is left raw, and anything unknown (no stamp, a failed
 * triage, an unanswered question) reads as worth reading — a wrong "noise"
 * costs a later promotion, a wrong "worth it" costs one extraction.
 */
export type ReadDepth = 'raw' | 'single' | 'full';

export interface DepthSignals {
  /** The stamps of every document read as one text; `undefined` = not triaged. */
  stamps: Array<TriageStamp | undefined>;
  /** A known entity the text mentions is in use (verified use, an open conflict, a pending expectation). */
  hot: boolean;
  /** Something asked for this text (an answer cited it; a correction beside it). */
  promoted: boolean;
  /** P(true) at or above which a triage question counts as yes. */
  floor: number;
}

/** The questions whose yes makes a text urgent: it changes what the memory holds, or how it answers. */
const URGENT = ['change', 'correction', 'instruction', 'identity'] as const;

/**
 * Read now, not when the conversation goes quiet: a standing instruction,
 * a correction, a change of state or a self-identification is visible on
 * the very next turn when it is wrong, so it does not wait for the settle
 * rule (§4.2 E-1/E-2).
 */
export function isUrgent(stamps: Array<TriageStamp | undefined>, floor: number): boolean {
  return stamps.some((s) => s !== undefined && URGENT.some((k) => s[k] >= floor));
}

export function readDepth(p: DepthSignals): ReadDepth {
  if (p.promoted || p.hot) return 'full';
  if (p.stamps.length === 0 || p.stamps.some((s) => s === undefined)) return 'full';
  const stamps = p.stamps as TriageStamp[];
  if (isUrgent(stamps, p.floor)) return 'full';
  const salience = Math.max(...stamps.map((s) => s.salience));
  // Notable or identity-central: read as carefully as we read.
  if (salience >= 2) return 'full';
  const durable = stamps.some((s) => s.durable >= p.floor);
  // Nothing worth knowing next week, nothing urgent, incidental: noise.
  if (!durable && salience === 0) return 'raw';
  return 'single';
}

/**
 * EXTRACTION_TRIAGE_FLOOR: the probability at or above which a triage
 * question counts as yes. Defaults to the plane's own decision boundary
 * (more likely yes than no); fitted on labelled corpora to the declared
 * recall, never hand-tuned (§4.4).
 */
export function triageFloor(): number {
  const n = Number(process.env.EXTRACTION_TRIAGE_FLOOR);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.5;
}
