/**
 * Eval-harness public types. Pure data shapes — no behaviour, no imports
 * from the SDK, no NestJS. Consumed by scenarios/, metrics/, runner/.
 */

export type Vertical =
  | 'rent'
  | 'estate'
  | 'events'
  | 'health'
  | 'shop'
  | 'cross';

// ── Setup steps: how the scenario seeds brain before running queries ──

export interface SetupFactStep {
  kind: 'fact';
  entityRef: { vertical: string; id: string };
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence?: number;
  source: { vertical: string; messageId?: string; eventId?: string };
  /**
   * Optional handle so later setup steps (retract / forget) can
   * reference this fact without knowing its server-assigned factId.
   * Tags live in scenario-local scope; the applier maintains a map
   * tag → factId and resolves retract steps against it.
   */
  tag?: string;
}

/**
 * Retract a previously-ingested fact. References the fact via the
 * `tag` set on its SetupFactStep — keeps scenarios declarative
 * without round-tripping factIds through the fixture file.
 */
export interface SetupRetractStep {
  kind: 'retract';
  tag: string;
  reason: string;
}

/**
 * Forget an entity (cascade-delete every fact, edge, embedding;
 * leave only the HMAC tombstone). References the entity by its
 * external ref (same form as ingest steps), which the applier
 * resolves to a server-side entityId.
 */
export interface SetupForgetStep {
  kind: 'forget';
  entityRef: { vertical: string; id: string };
  reason: 'gdpr_request' | 'tenant_offboarding' | 'operator_request';
  requestId: string;
}

export interface SetupMentionStep {
  kind: 'mention';
  text: string;
  contextRef: {
    vertical: string;
    conversationId?: string;
    messageId?: string;
  };
  knownEntities?: Array<{ vertical: string; id: string; role?: string }>;
  emittedAt: string;
  /**
   * Predicates the LLM is expected to surface from this text. Used for
   * extraction-recall scoring. The harness is lenient — partial matches
   * count, distractor predicates do not fail.
   */
  expectedPredicates?: string[];
  /**
   * Minimum number of entities the LLM should produce. Default 1.
   */
  minEntities?: number;
}

export interface SetupLinkStep {
  kind: 'link';
  from: { vertical: string; id: string };
  to: { vertical: string; id: string };
  linkKind: string;
  source: { vertical: string; eventId?: string };
}

export type SetupStep =
  | SetupFactStep
  | SetupMentionStep
  | SetupLinkStep
  | SetupRetractStep
  | SetupForgetStep;

// ── Query expectations ────────────────────────────────────────────────

export interface QueryExpectation {
  query: string;
  /**
   * The externalRef of the entity that should rank top. Resolved by the
   * runner against actual brain results (which carry externalRefs).
   * Format: '<vertical>.<id>'.
   */
  expectedTopEntityRef: string;
  /**
   * Optional: predicate the top hit's facts list should contain at least
   * one of. Useful for asserting "we found the complaint, not just the
   * customer profile".
   */
  expectedFactPredicate?: string;
  /**
   * Optional asOf for bitemporal queries.
   */
  asOf?: string;
  /**
   * Optional: scopes the simulated caller has. Default: read+pii.
   */
  callerScopes?: Array<'brain:read' | 'brain:write' | 'brain:read_pii' | 'brain:admin'>;
  /**
   * Soft gate (fact-level). If set, the query is run with a
   * limited-scope caller; the metric scores correct iff the gated
   * predicate does NOT appear in any returned fact for the expected
   * entity. This matches brain's actual semantics — entities can
   * surface through their non-PII facts, but PII facts MUST be
   * stripped server-side.
   */
  mustNotLeakPredicate?: string;
}

// ── Memory-lifecycle assertions ───────────────────────────────────────
// Run AFTER setup, BEFORE queries. They check that brain's read-side
// reflects the lifecycle operations (update, retract, forget) declared
// in the setup. Each assertion is a single boolean check against a
// specific brain endpoint.

export interface MemoryAssertion {
  /**
   * Free-text label. Surfaced in the report so a failing assertion
   * tells the operator WHICH lifecycle invariant broke.
   */
  description: string;
  kind:
    | 'no_search_match' // search returns no hit matching expectedRefAbsent
    | 'search_object_present' // expectedRefPresent's facts contain object substring
    | 'search_object_absent'; // expectedRefAbsent's facts do NOT contain object substring
  /** Free-text query for `no_search_match` / `search_object_*` kinds. */
  query?: string;
  /**
   * Required for `no_search_match` and `search_object_absent` — the
   * externalRef whose presence/facts we're checking against.
   */
  expectedRefAbsent?: string;
  /** Required for `search_object_present`. */
  expectedRefPresent?: string;
  /**
   * For `search_object_*` kinds — the substring (case-insensitive)
   * we expect to see / not see in the matching entity's facts.
   */
  objectSubstring?: string;
  /**
   * Optional includeRetracted flag for the search call. Default
   * false (the default-search behaviour we're trying to validate).
   * Set true on the asOf-historical sub-tests where the retracted
   * fact SHOULD still surface.
   */
  includeRetracted?: boolean;
  /** Optional asOf for bitemporal lifecycle assertions. */
  asOf?: string;
}

// ── Scenario ──────────────────────────────────────────────────────────

export interface Scenario {
  id: string;
  vertical: Vertical;
  description: string;
  setup: SetupStep[];
  queries: QueryExpectation[];
  /**
   * Optional cross-vertical assertion: the entity at expectedSurvivor
   * should absorb the entity at expectedLoser after an identity_of link.
   */
  identityMerge?: {
    survivorRef: string; // '<vertical>.<id>'
    loserRef: string;
  };
  /**
   * Optional memory-lifecycle assertions. Run AFTER setup, BEFORE
   * queries. Aggregated into the `memory-lifecycle-correctness`
   * metric — % assertions that passed across the suite.
   */
  memoryAssertions?: MemoryAssertion[];
}

// ── Metric outputs (per scenario / aggregate) ─────────────────────────

export interface QueryResult {
  query: string;
  expectedTopEntityRef: string;
  rankOfExpected: number; // 1-based; 0 means not in returned page
  topEntityRef: string | null;
  factPredicateMatched: boolean | null; // null if not asserted
  piiGatedCorrectly: boolean | null;
  /**
   * True when the query carried an `asOf` (bitemporal/historical
   * intent). Aggregator splits the metric set by this flag — a 0.88
   * recall@1 averaged over both partitions can hide that the
   * as-of-T slice is silently 0.50 (typical regression mode for a
   * non-bitemporal retrieval rewrite).
   */
  temporal: boolean;
}

export interface ExtractionResult {
  scenarioId: string;
  text: string;
  expectedPredicates: string[];
  observedPredicates: string[];
  predicateRecall: number; // 0..1 over expectedPredicates
  entitiesObserved: number;
  minEntities: number;
}

export interface IdentityMergeResult {
  scenarioId: string;
  survivorRef: string;
  loserRef: string;
  merged: boolean;
}

export interface MemoryAssertionResult {
  scenarioId: string;
  description: string;
  kind: MemoryAssertion['kind'];
  passed: boolean;
  /** Short detail for the report (e.g. "search returned cust_42 unexpectedly"). */
  detail?: string;
}

export interface ScenarioOutcome {
  scenarioId: string;
  vertical: Vertical;
  queryResults: QueryResult[];
  extractionResults: ExtractionResult[];
  identityMergeResult?: IdentityMergeResult;
  memoryAssertionResults: MemoryAssertionResult[];
}

export interface AggregateMetric {
  name: string;
  /** null = no data for this metric in this slice (e.g. no mentions to score) */
  value: number | null;
  threshold?: number;
  unit?: string;
}

export interface VerticalReport {
  vertical: Vertical;
  scenarios: number;
  metrics: AggregateMetric[];
}

export interface EvalReport {
  perVertical: VerticalReport[];
  overall: AggregateMetric[];
  outcomes: ScenarioOutcome[];
}
