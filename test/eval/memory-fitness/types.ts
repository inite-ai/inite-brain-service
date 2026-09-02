/**
 * Shared shapes of the memory-fitness harness.
 *
 * The harness treats the brain as the FIRST-PERSON memory of one
 * engineering agent: the corpus is what the agent wrote into its own
 * memory, the questions are what the same agent would genuinely ask
 * later, and every expectation is authored together with the corpus so
 * scoring stays mechanical (no LLM judge).
 */

/** One first-person mention turn the agent writes into its memory. */
export interface CorpusTurn {
  /** Conversation key (`c1`..`c5`) — the runner prefixes it with the run id. */
  conversation: string;
  /** 1-based position inside the conversation (drives the messageId). */
  turn: number;
  /** ISO 8601 emission timestamp — the temporal anchor of the turn. */
  emittedAt: string;
  /** Verbatim first-person text. Kept under the 600-char provenance cap. */
  text: string;
}

/** Evidence pointer accepted by the `record_fact` MCP tool. */
export interface DirectFactEvidence {
  kind: 'event' | 'message' | 'conversation' | 'url' | 'document' | 'commit' | 'other';
  ref: string;
  note?: string;
}

/** One direct `record_fact` call (the grounding-mix half of the corpus). */
export interface DirectFact {
  /** Stable key for logs and the report file. */
  key: string;
  entityRef: { vertical: string; id: string };
  predicate: string;
  object: string;
  /** ISO 8601 datetime. */
  validFrom: string;
  validUntil?: string;
  confidence?: number;
  /**
   * Conversation key this fact was observed in — the runner expands it
   * to the run-scoped conversationId (grounds the claim). Absent on the
   * deliberately ungrounded facts.
   */
  conversation?: string;
  /** Typed evidence pointers; absent on the deliberately ungrounded facts. */
  evidence?: DirectFactEvidence[];
}

export type Dimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8';

interface QuestionBase {
  id: string;
  dimension: Dimension;
  /** The question exactly as the returning agent would ask it. */
  prompt: string;
}

/** D1 — state currency: current value served, stale value absent. */
export interface CurrencyQuestion extends QuestionBase {
  kind: 'currency';
  /** Answer passes when it contains at least one of these. */
  expectAnyOf: string[];
  /** Answer fails when it contains any of these (the stale value). */
  forbidAnyOf: string[];
}

/** D2 — evolution history via the entity timeline (old + new, ordered). */
export interface EvolutionQuestion extends QuestionBase {
  kind: 'evolution';
  /** search_knowledge query used to resolve the entity. */
  entityQuery: string;
  predicate: string;
  /** Markers of the earlier value (anyOf). */
  oldMarkers: string[];
  /** Markers of the later value (anyOf). */
  newMarkers: string[];
}

/** D2 (belief leg) — the promoted belief carries value + priorValue. */
export interface BeliefEvolutionQuestion extends QuestionBase {
  kind: 'belief-evolution';
  /** Markers the CURRENT belief value must match (anyOf). */
  valueMarkers: string[];
  /** Markers the priorValue must match (anyOf). */
  priorMarkers: string[];
}

/** D3 — provenance unrollability: a served fact unrolls to a seeded turn. */
export interface ProvenanceQuestion extends QuestionBase {
  kind: 'provenance';
  searchQuery: string;
  /** Prefer facts whose predicate contains this substring, else any hit. */
  predicateHint?: string;
  /**
   * Case-insensitive fragments seeded in the corpus turns; the walk
   * passes when ≥1 provenance episode's text matches ≥1 fragment.
   */
  episodeFragments: string[];
}

/** D4 — temporal anchor: the served answer names the expected date. */
export interface TemporalQuestion extends QuestionBase {
  kind: 'temporal';
  /** Expected date as `yyyy-mm-dd`; the scorer accepts common phrasings. */
  expectDate: string;
}

/** D5 — absence honesty: never-written topic must yield abstention. */
export interface AbsenceQuestion extends QuestionBase {
  kind: 'absence';
}

/** D6 — conflict surfacing via the competing-facts API. */
export interface ConflictApiQuestion extends QuestionBase {
  kind: 'conflict-api';
  entityQuery: string;
  predicate: string;
  sideA: string[];
  sideB: string[];
}

/** D6 — conflict surfacing in the served answer. */
export interface ConflictAnswerQuestion extends QuestionBase {
  kind: 'conflict-answer';
  sideA: string[];
  sideB: string[];
}

/** D7 — cross-session integration (joins two conversations). */
export interface IntegrationQuestion extends QuestionBase {
  kind: 'integration';
  expectAnyOf: string[];
}

/** D8 — self-utility replay, scored by key-phrase presence. */
export interface ReplayQuestion extends QuestionBase {
  kind: 'replay';
  /**
   * Every group must be satisfied; a string is a required substring, a
   * string[] is an any-of group.
   */
  keyPhrases: Array<string | string[]>;
}

export type Question =
  | CurrencyQuestion
  | EvolutionQuestion
  | BeliefEvolutionQuestion
  | ProvenanceQuestion
  | TemporalQuestion
  | AbsenceQuestion
  | ConflictApiQuestion
  | ConflictAnswerQuestion
  | IntegrationQuestion
  | ReplayQuestion;

/** Per-question outcome in the scorecard / JSON report. */
export interface QuestionResult {
  id: string;
  dimension: Dimension;
  prompt: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
  latencyMs: number;
  /** Raw served answer, when the question was answer-shaped. */
  answer?: string | null;
}

export interface DimensionTally {
  pass: number;
  fail: number;
  skipped: number;
}

export interface Scorecard {
  runId: string;
  baseUrl: string;
  companyId: string;
  userId: string;
  guardrails: string;
  startedAt: string;
  finishedAt: string;
  ingest: { mentionTurns: number; directFacts: number; builds: Record<string, string> };
  dimensions: Record<Dimension, DimensionTally>;
  overall: DimensionTally & { total: number };
  questions: QuestionResult[];
}
