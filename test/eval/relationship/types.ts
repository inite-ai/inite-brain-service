/**
 * Shared shapes of the relationship battery (docs/roadmap/relationship-layer-2026-10.md §5).
 *
 * The brain under test is the memory a coaching programme keeps of ONE
 * participant, read by two surfaces: the coach that the participant
 * talks to, and a general assistant the participant also uses. Every
 * expectation is authored together with the corpus, so scoring stays
 * mechanical (no LLM judge).
 */

/** Who says the turn. The specialist is a human counterpart. */
export type Speaker = 'person' | 'coach' | 'specialist';

/** The surface a check asks through — one credential each. */
export type Surface = 'coach' | 'assistant';

/** One turn of the corpus. */
export interface CorpusTurn {
  /** Conversation key (`c1`..`c5`) — the runner prefixes it with the run id. */
  conversation: string;
  /** 1-based position inside the conversation (drives the messageId). */
  turn: number;
  /**
   * Days before the run's anchor (fractional allowed). Relative on
   * purpose: "a week-old state is stale" and "a commitment is overdue"
   * must hold whenever the battery runs.
   */
  daysAgo: number;
  speaker: Speaker;
  /** Verbatim text, Brazilian Portuguese — the coach's first market. */
  text: string;
}

export type Check = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'A1';

interface ProbeBase {
  id: string;
  check: Check;
  surface: Surface;
  /** The question exactly as that surface would ask it. */
  prompt: string;
}

/**
 * Served answer must satisfy every group (a string is required, a
 * string[] is any-of). Abstention fails: the memory holds the answer.
 */
export interface ExpectProbe extends ProbeBase {
  kind: 'expect';
  groups: Array<string | string[]>;
}

/**
 * R3 — the same question through both surfaces: the coach must get the
 * disclosure, the assistant must not. Both halves, because a fence that
 * answers nobody would pass the negative half for the wrong reason.
 */
export interface FenceProbe extends ProbeBase {
  kind: 'fence';
  /** The coach's answer must contain ≥1 of these. */
  ownerAnyOf: string[];
  /** The assistant's answer must contain NONE of these. */
  forbidForOthers: string[];
}

/**
 * Markers that may appear only when qualified — told as past (R1), as
 * rejected (R8) or as an unconfirmed guess (R5). Abstaining passes;
 * `expectAnyOf`, when set, must also be present (then abstention fails).
 */
export interface QualifiedProbe extends ProbeBase {
  kind: 'qualified';
  markers: string[];
  qualifiers: 'past' | 'negated' | 'hedged' | 'past-or-hedged';
  expectAnyOf?: string[];
}

/** A never-written topic: the answer must abstain. */
export interface AbsenceProbe extends ProbeBase {
  kind: 'absence';
}

/**
 * A check that needs the relationship surface (step 1+) or voice (step
 * 5). Skipped, never passed, while the stand does not list the tool.
 */
export interface RequiresProbe extends ProbeBase {
  kind: 'requires';
  tool: string;
}

export type Probe = ExpectProbe | FenceProbe | QualifiedProbe | AbsenceProbe | RequiresProbe;

export interface ProbeResult {
  id: string;
  check: Check;
  surface: Surface;
  prompt: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
  latencyMs: number;
  /** Raw served answer(s), when the probe was answer-shaped. */
  answer?: string | null;
  otherAnswer?: string | null;
}

export interface Tally {
  pass: number;
  fail: number;
  skipped: number;
}

export interface Scorecard {
  runId: string;
  baseUrl: string;
  companyId: string;
  guardrails: string;
  /** Whether the two surfaces used distinct credentials. */
  distinctSurfaces: boolean;
  startedAt: string;
  finishedAt: string;
  anchor: string;
  turns: number;
  checks: Record<Check, Tally>;
  overall: Tally & { total: number };
  probes: ProbeResult[];
}
