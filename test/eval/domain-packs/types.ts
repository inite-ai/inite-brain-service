/**
 * Shared shapes of the domain-pack battery — the third mechanical
 * sibling of test/eval/memory-fitness (general first-person memory
 * fitness) and test/eval/state-transitions (mutable world-state).
 * This battery isolates ONE claim: memory behaves correctly WITH
 * industry Domain Packs installed — the install→vocabulary→trace
 * chain works end to end, and ONE entity living in TWO domain
 * ontologies (fintech + medical) stays a single entity whose facts,
 * timeline and provenance keep their per-domain identity.
 *
 * Every check is mechanical — no LLM judge (see scorers.ts).
 */

/** One mention turn the runner writes into memory. */
export interface CorpusTurn {
  /** Conversation key (`fin`…) — the runner prefixes it with the run id. */
  conversation: string;
  /** 1-based position inside the conversation (drives the messageId). */
  turn: number;
  /** ISO 8601 emission timestamp — the temporal anchor of the turn. */
  emittedAt: string;
  /** Verbatim turn text. Kept under the 600-char provenance cap. */
  text: string;
}

/** A domain lens: its pack namespace plus corpus value markers. A fact
 *  belongs to the domain when its predicate carries the `<namespace>__`
 *  prefix OR its text matches a marker — so the cross-domain checks
 *  stay meaningful even while extraction still coins open-vocab
 *  predicates (the pack-vocab baseline finding). */
export interface DomainSpec {
  namespace: string;
  markers: string[];
}

interface BaseCheck {
  /** Stable key (`c01-install`…) used in the report. */
  id: string;
  /** Check class — the scorecard groups by this. */
  cls: string;
  /** What the check asserts and what would falsify it. */
  intent: string;
}

/** `install` — GET /v1/admin/packs lists both packs as installed. */
export interface InstallCheck extends BaseCheck {
  kind: 'install';
  packs: Array<{ packId: string; version: string }>;
}

/**
 * `pack-vocab` — a searched fact's predicate is the EXACT namespaced
 * pack predicate (`fintech__settlement_period`), proving domain
 * phrasing canonicalized into the installed pack's vocabulary instead
 * of a coined open-vocab predicate. `expectedUnknown` marks the honest
 * baseline: a fail here is a FINDING (extraction may not consult the
 * installed pack's extractionProfile on this path yet — the
 * state-transitions battery's knownFailToday idea, for an outcome that
 * has never been measured), not a forced green.
 */
export interface PackVocabCheck extends BaseCheck {
  kind: 'pack-vocab';
  searchQuery: string;
  /** The exact namespaced predicate id, derived from the pack manifest. */
  predicate: string;
  /** The fact's object must contain ≥1 of these (case-insensitive). */
  valueMarkers: string[];
  /** Baseline annotation: outcome unknown on today's code; a fail is
   *  recorded as a finding, tallied separately, never forced green. */
  expectedUnknown?: string;
}

/** `pack-transition` — the entity timeline retains old→new on a pack
 *  predicate as a chronological subsequence (the state-transitions
 *  battery's checkHistorySequence, reused verbatim). */
export interface PackTransitionCheck extends BaseCheck {
  kind: 'pack-transition';
  searchQuery: string;
  /** Ordered stages; each stage is an anyOf marker group. */
  stages: string[][];
}

/** `cross-entity` — search returns ONE entity (no per-domain
 *  duplication) carrying facts from BOTH domains plus generic ones. */
export interface CrossEntityCheck extends BaseCheck {
  kind: 'cross-entity';
  searchQuery: string;
  /** The subject entity's canonicalName must contain this token; hits
   *  are deduped on it (2+ matching hits = per-domain duplication). */
  entityNameToken: string;
  domains: [DomainSpec, DomainSpec];
  /** Markers of the domain-free corpus turns about the same entity. */
  genericMarkers: string[];
}

/** `trace-provenance` — a domain fact of the shared entity unrolls via
 *  get_fact_provenance to an episode quoting that domain's seeded turn
 *  verbatim (the memory-fitness walkProvenance, with its round-robin
 *  candidate interleave). */
export interface TraceProvenanceCheck extends BaseCheck {
  kind: 'trace-provenance';
  searchQuery: string;
  /** Prefer facts whose object contains ≥1 of these, else any fact. */
  objectHint: string[];
  /** Case-insensitive fragments seeded verbatim in exactly one turn. */
  episodeFragments: string[];
}

/** `trace-interleave` — the shared entity's timeline holds
 *  fact.recorded events from BOTH domains and neither domain sits
 *  entirely before the other in time (a genuine interleave). */
export interface TraceInterleaveCheck extends BaseCheck {
  kind: 'trace-interleave';
  searchQuery: string;
  entityNameToken: string;
  domains: [DomainSpec, DomainSpec];
}

/** `serve-cross` — synthesize over the shared entity cites BOTH
 *  domains: at least one marker from every group must be served. */
export interface ServeCrossCheck extends BaseCheck {
  kind: 'serve-cross';
  query: string;
  /** Every group is an anyOf set; ALL groups must be satisfied. */
  requireGroups: string[][];
}

/** `serve-isolation` — a domain-specific question answers from ITS
 *  domain's fact and never confabulates the other domain's values. */
export interface ServeIsolationCheck extends BaseCheck {
  kind: 'serve-isolation';
  query: string;
  /** Pass requires ≥1 of these in the answer. */
  expectAnyOf: string[];
  /** Any of these in the answer fails the check (checked first). */
  forbidAnyOf: string[];
}

/** `no-rogue-tools` — MCP tools/list carries ZERO `__`-namespaced pack
 *  tools. Neither installed pack declares mcpTools, so the no-op is
 *  ASSERTED, not assumed; this flips to a positive check the day a
 *  pack ships tools (see README.md). */
export interface NoRogueToolsCheck extends BaseCheck {
  kind: 'no-rogue-tools';
}

export type Check =
  | InstallCheck
  | PackVocabCheck
  | PackTransitionCheck
  | CrossEntityCheck
  | TraceProvenanceCheck
  | TraceInterleaveCheck
  | ServeCrossCheck
  | ServeIsolationCheck
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
  /** Carried through from the check: baseline finding, not regression. */
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
  /** Phase-0 pack setup trail (per pack: already installed / installed /
   *  registry-published), so a report is reproducible from itself. */
  setup: Record<string, string>;
  ingest: { mentionTurns: number };
  /** Per-check-class tally. */
  classes: Record<string, Tally>;
  /** Per-check-kind tally. */
  checkKinds: Record<CheckKind, Tally>;
  checks: Tally & { total: number; failedExpectedUnknown: number };
  results: CheckResult[];
}
