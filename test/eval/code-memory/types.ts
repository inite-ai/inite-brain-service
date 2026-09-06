/**
 * Shared shapes of the code-memory battery — the fourth mechanical
 * sibling of test/eval/memory-fitness (general first-person memory
 * fitness), test/eval/state-transitions (mutable world-state) and
 * test/eval/domain-packs (installed industry packs). This battery
 * isolates ONE claim: **a coding agent's turns about its own repo
 * become recallable, current, provenance-clean code memory** — with
 * the BUILTIN `code_memory` pack, which is never installed (bootstrap
 * seeds its predicates into every tenant), so the battery also asserts
 * the builtin seeding path itself.
 *
 * Every check is mechanical — no LLM judge (see scorers.ts).
 */

/** One mention turn the runner writes into memory. */
export interface CorpusTurn {
  /** Conversation key (`decision`…) — the runner prefixes it with the run id. */
  conversation: string;
  /** 1-based position inside the conversation (drives the messageId). */
  turn: number;
  /** ISO 8601 emission timestamp — the temporal anchor of the turn. */
  emittedAt: string;
  /** Verbatim turn text. Kept under the 600-char provenance cap. */
  text: string;
}

interface BaseCheck {
  /** Stable key (`k01-builtin-vocab`…) used in the report. */
  id: string;
  /** Check class — the scorecard groups by this. */
  cls: string;
  /** What the check asserts and what would falsify it. */
  intent: string;
  /**
   * Honest-baseline annotation (the domain-pack battery's
   * `expectedUnknown` pattern): the outcome depends on work that has
   * not landed (the pack 0.4.0 ontology increment, the coding-verb
   * state-verb lexicon reaching the stand, an extractionProfile for
   * code_memory) or has simply never been measured. The runner still
   * EXECUTES the check — a fail is recorded as a finding and tallied
   * separately (`failedExpectedUnknown`), never forced green; the run
   * where it passes is the measured signal that the gap closed.
   */
  expectedUnknown?: string;
}

/** `builtin-vocab` — the builtin pack's namespaced predicates are
 *  active in the tenant WITHOUT any install (bootstrap seeding). */
export interface BuiltinVocabCheck extends BaseCheck {
  kind: 'builtin-vocab';
  /** Namespaced predicate ids that must be listed as active. */
  requiredPredicates: string[];
}

/** `pack-vocab` — a searched fact's predicate is the EXACT namespaced
 *  code_memory predicate (same shape as the domain-pack battery's
 *  check). For predicates arriving with pack 0.4.0 the corpus computes
 *  the gap annotation from the live manifest, so the check flips to a
 *  plain assertion the moment the ontology increment lands. */
export interface PackVocabCheck extends BaseCheck {
  kind: 'pack-vocab';
  searchQuery: string;
  /** The exact namespaced predicate id (`code_memory__decided`…). */
  predicate: string;
  /** The fact's object must contain ≥1 of these (case-insensitive). */
  valueMarkers: string[];
}

/** `literal-harvest` — the deterministic literal lane produces its
 *  CORE facts (identifier / service_port / rate_limit) from
 *  identifier-heavy coding prose. Every want must be found. */
export interface LiteralHarvestCheck extends BaseCheck {
  kind: 'literal-harvest';
  wants: Array<{
    searchQuery: string;
    /** Exact core predicate id (`service_port`…). */
    predicate: string;
    valueMarkers: string[];
  }>;
}

/** `flag-transition` — the flag's 0→1 story is retained as ordered
 *  history on ONE entity's timeline (the state-transitions battery's
 *  checkHistorySequence, reused verbatim). */
export interface FlagTransitionCheck extends BaseCheck {
  kind: 'flag-transition';
  searchQuery: string;
  /** Ordered stages; each stage is an anyOf marker group. */
  stages: string[][];
}

/** `supersession-asof` — MCP record_decision re-record on one anchor:
 *  `why` now shows exactly ONE active decision (the new one), and
 *  `why` at an asOf between the two writes still recalls the OLD one
 *  (bitemporal supersession, the single_active law). */
export interface SupersessionCheck extends BaseCheck {
  kind: 'supersession-asof';
  /** Anchor symbol — the runner salts it with the run id. */
  anchor: string;
  oldText: string;
  newText: string;
  oldMarkers: string[];
  newMarkers: string[];
}

/** `cross-entity` — the module referenced by file path AND by symbol
 *  name resolves to ONE entity carrying facts from both phrasings. */
export interface CrossEntityCheck extends BaseCheck {
  kind: 'cross-entity';
  searchQuery: string;
  /** A hit belongs to the module when its canonicalName contains ≥1. */
  nameTokens: string[];
  /** Each group is an anyOf set seeded by a DIFFERENT phrasing's turn;
   *  the single entity must carry ≥1 fact per group. */
  mustCarryGroups: string[][];
}

/** `trace-provenance` — a code fact unrolls via get_fact_provenance to
 *  an episode quoting the seeded turn verbatim (memory-fitness
 *  walkProvenance + round-robin candidate interleave). */
export interface TraceProvenanceCheck extends BaseCheck {
  kind: 'trace-provenance';
  searchQuery: string;
  /** Prefer facts whose object contains ≥1 of these, else any fact. */
  objectHint: string[];
  /** Case-insensitive fragments seeded verbatim in exactly one turn. */
  episodeFragments: string[];
}

/** `serve` — synthesize answers a serving question with the current
 *  value and without the forbidden (stale/foreign) markers (the
 *  state-transitions scoreServe, reused verbatim). */
export interface ServeCheck extends BaseCheck {
  kind: 'serve';
  query: string;
  expectAnyOf: string[];
  forbidAnyOf: string[];
}

/** `intention-guard` — the voiced-plan turns ("we should probably
 *  enable X", "we haven't enabled X") must NOT have produced a
 *  completed state transition anywhere. */
export interface IntentionGuardCheck extends BaseCheck {
  kind: 'intention-guard';
  searchQuery: string;
  /** The forbidden fact: this exact predicate… */
  forbidPredicate: string;
  /** …with an object matching ≥1 of these markers. */
  forbidObjectMarkers: string[];
}

/** `mcp-roundtrip` — record_decision → why on a fresh anchor
 *  round-trips (found>0, right kind, verbatim text). */
export interface McpRoundtripCheck extends BaseCheck {
  kind: 'mcp-roundtrip';
  /** Anchor symbol — the runner salts it with the run id. */
  anchor: string;
  recordKind: string;
  text: string;
  textMarkers: string[];
}

/** `no-rogue-tools` — tools/list carries ZERO `__`-namespaced pack
 *  tools: the code-memory tools (`why` / `recall_decisions` /
 *  `record_decision`) are core-hardcoded single-underscore names, and
 *  no pack declares mcpTools today (domain-pack battery law). */
export interface NoRogueToolsCheck extends BaseCheck {
  kind: 'no-rogue-tools';
}

export type Check =
  | BuiltinVocabCheck
  | PackVocabCheck
  | LiteralHarvestCheck
  | FlagTransitionCheck
  | SupersessionCheck
  | CrossEntityCheck
  | TraceProvenanceCheck
  | ServeCheck
  | IntentionGuardCheck
  | McpRoundtripCheck
  | NoRogueToolsCheck;
export type CheckKind = Check['kind'];

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  kind: CheckKind;
  cls: string;
  status: CheckStatus;
  detail: string;
  latencyMs: number;
  /** Raw served answer, when the check was answer-shaped. */
  answer?: string | null;
  /** Carried through from the check: gap-gated finding, not regression. */
  expectedUnknown?: string;
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
  /** Phase-0 trail (builtin predicate presence — no install happens;
   *  the builtin id is REJECTED by the install path by design). */
  setup: Record<string, string>;
  ingest: { mentionTurns: number };
  /** Per-check-class tally. */
  classes: Record<string, Tally>;
  /** Per-check-kind tally. */
  checkKinds: Record<CheckKind, Tally>;
  checks: Tally & { total: number; failedExpectedUnknown: number };
  /** The ids of gap-gated checks (expectedUnknown), pass or fail — so
   *  the report states its own honesty policy. */
  gapGatedChecks: string[];
  results: CheckResult[];
}
