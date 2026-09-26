import type { TriageStamp } from './triage';

/**
 * How deep a captured text is read (docs/roadmap/raw-processing-triggers-
 * 2026-09.md §4.1–4.2), decided from its D1 triage stamp, what the memory
 * is using now, and what asked for it. Pure — no DB, no LLM.
 *
 * Read on demand, not on arrival. Extraction is the expensive step; most
 * of what is said is never asked about again, and until it is, the raw
 * turns serve it (every raw lane reads them). So only what would be wrong
 * on the very next turn is read at once:
 *  - `full` — urgent (a change, a correction, an instruction, a self-
 *    identification), notable (salience ≥ 2), naming an entity in use,
 *    untriaged (the judge unavailable — the asymmetric default), or asked
 *    for by an answer or beside an urgent read;
 *  - `single` — one sample: a current value of something that can change
 *    (the baseline a later change replaces), or the idle budget reading
 *    the deferred backlog;
 *  - `raw` — everything else — events, opinions, stories, logistics, kept as raw turns until something asks for
 *    it (CandidateStoreService.promote).
 */
export type ReadDepth = 'raw' | 'single' | 'full';

/** Why a read was asked for (the run's priority, 0168). */
export type ReadAsk = 'idle' | 'neighbour' | 'answer';

export interface DepthSignals {
  /** The stamps of every document read as one text; `undefined` = not triaged. */
  stamps: Array<TriageStamp | undefined>;
  /** A known entity the text mentions is in use (verified use, an open conflict, a pending expectation). */
  hot: boolean;
  /** What asked for this text, if anything. */
  asked: ReadAsk | undefined;
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
  if (p.asked === 'answer' || p.asked === 'neighbour' || p.hot) return 'full';
  if (p.stamps.length === 0 || p.stamps.some((s) => s === undefined)) return 'full';
  const stamps = p.stamps as TriageStamp[];
  if (isUrgent(stamps, p.floor)) return 'full';
  // Notable or identity-central: read as carefully as we read.
  if (Math.max(...stamps.map((s) => s.salience)) >= 2) return 'full';
  // A current value of something that can change is read when it
  // arrives, one sample: it is the baseline a later change replaces, and
  // a change arriving against nothing has nothing to supersede. The idle
  // budget reads the deferred backlog the same way.
  if (stamps.some((s) => s.state >= p.floor) || p.asked === 'idle') return 'single';
  return 'raw';
}

/** A run's priority (0168) as what asked for the read. */
export function askOf(priority: number): ReadAsk | undefined {
  return priority >= PRIORITY.answer
    ? 'answer'
    : priority >= PRIORITY.neighbour
      ? 'neighbour'
      : priority >= PRIORITY.idle
        ? 'idle'
        : undefined;
}

/** Run priorities (0168): what asked for a read, highest first in the queue. */
export const PRIORITY = { idle: 1, neighbour: 2, answer: 3 } as const;

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
