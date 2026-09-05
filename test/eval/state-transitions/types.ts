/**
 * Shared shapes of the state-transition battery — the mechanical sibling
 * of test/eval/memory-fitness. Where memory-fitness measures general
 * first-person memory fitness (eight dimensions over one corpus), this
 * battery isolates ONE claim: memory tracks a mutable world-state.
 * Each scenario seeds a state transition (or a deliberate NON-transition)
 * for its own entity and declares 2-4 typed checks the runner executes
 * after the builds. Every check is mechanical — no LLM judge.
 */

/** One first-person mention turn a scenario writes into memory. */
export interface ScenarioTurn {
  /** Conversation key (`s01a`…) — the runner prefixes it with the run id. */
  conversation: string;
  /** 1-based position inside the conversation (drives the messageId). */
  turn: number;
  /** ISO 8601 emission timestamp — the temporal anchor of the turn. */
  emittedAt: string;
  /** Verbatim first-person text. Kept under the 600-char provenance cap. */
  text: string;
}

/**
 * `belief` — the promoted semantic belief for a (subject, field) key
 * carries the expected current value, prior value and revision depth.
 * Read via GET /v1/beliefs?userId=… (BELIEFS_API_ENABLED).
 */
export interface BeliefCheck {
  kind: 'belief';
  id: string;
  /** Belief.subject must contain ≥1 of these (case-insensitive). */
  subjectTokens: string[];
  /** Belief.field must contain ≥1 of these (case-insensitive). */
  fieldTokens: string[];
  /** When present: belief.value must contain ≥1 of these. */
  valueMarkers?: string[];
  /** When present: priorValue must EXIST and contain ≥1 of these. */
  priorMarkers?: string[];
  /** When true: priorValue must be absent (a first-revision belief). */
  priorAbsent?: boolean;
  /** When present: belief.revision must be >= this. */
  minRevision?: number;
  /** Baseline annotation: this check is expected to FAIL on today's code. */
  knownFailToday?: string;
}

/**
 * `fact-history` — the entity timeline retains every stage of the
 * transition as `fact.recorded` events, in emission order. Stages are
 * matched greedily as a subsequence over `${predicate} ${object}` so a
 * later stage never has to compete with an earlier event (the sibling's
 * checkEvolution idea, generalised to N stages and free predicates).
 */
export interface FactHistoryCheck {
  kind: 'fact-history';
  id: string;
  /** search_knowledge query used to find candidate entities. */
  searchQuery: string;
  /** Ordered stages; each stage is an anyOf marker group. */
  stages: string[][];
  knownFailToday?: string;
}

/**
 * `serve` — synthesize serves CURRENT truth. Marker semantics follow
 * the sibling's D1 forbid-lesson: prefer expectAnyOf on the current
 * marker; use forbidAnyOf only where naming the old value at all is an
 * unambiguous stale leak. Scoring is marker-FIRST: an honest negative
 * answer ("you don't have a bike anymore") trips the shared decline
 * regex, so abstention only fails a serve when no expect marker hit.
 */
export interface ServeCheck {
  kind: 'serve';
  id: string;
  query: string;
  /** Pass requires ≥1 of these in the answer (unless conflictSides). */
  expectAnyOf?: string[];
  /** Any of these in the answer fails the check (checked first). */
  forbidAnyOf?: string[];
  /** Pass iff the answer is an abstention (never combined with expect). */
  expectAbstain?: boolean;
  /**
   * Conflict mode (scenario 7): honest behaviours are naming BOTH sides
   * or abstaining — the sibling's classifyConflictAnswer semantics.
   */
  conflictSides?: { sideA: string[]; sideB: string[] };
  knownFailToday?: string;
}

/**
 * `provenance` — a fact about the transitioned state unrolls to an
 * episode quoting a seeded fragment verbatim (the sibling's
 * walkProvenance over get_fact_provenance).
 */
export interface ProvenanceCheck {
  kind: 'provenance';
  id: string;
  searchQuery: string;
  /** Prefer facts whose predicate contains this substring, else any hit. */
  predicateHint?: string;
  /** Case-insensitive fragments seeded verbatim in the scenario turns. */
  episodeFragments: string[];
  knownFailToday?: string;
}

export type Check = BeliefCheck | FactHistoryCheck | ServeCheck | ProvenanceCheck;
export type CheckKind = Check['kind'];

/** One scenario: its own entity/object, its turns, its checks. */
export interface Scenario {
  /** Stable key (`s01`…) used in conversation ids and the report. */
  key: string;
  /** Human name of the transition mechanic under test. */
  name: string;
  /** Scenario class — the scorecard groups by this. */
  cls: string;
  /** What the scenario seeds and what would falsify the claim. */
  intent: string;
  turns: ScenarioTurn[];
  checks: Check[];
}

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  kind: CheckKind;
  status: CheckStatus;
  detail: string;
  latencyMs: number;
  /** Raw served answer, when the check was answer-shaped. */
  answer?: string | null;
  /** Carried through from the check: expected to fail on today's code. */
  knownFailToday?: string;
}

export interface ScenarioResult {
  key: string;
  name: string;
  cls: string;
  /** pass = ALL checks passed; skipped = no fail but ≥1 skipped. */
  status: CheckStatus;
  checks: CheckResult[];
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
  userId: string;
  guardrails: string;
  startedAt: string;
  finishedAt: string;
  ingest: { mentionTurns: number; builds: Record<string, string> };
  /** Per-scenario-class tally (of scenarios). */
  classes: Record<string, Tally>;
  /** Per-check-kind tally (of checks). */
  checkKinds: Record<CheckKind, Tally>;
  scenarios: { pass: number; fail: number; skipped: number; total: number };
  checks: Tally & { total: number; failedExpectedToday: number };
  results: ScenarioResult[];
}
