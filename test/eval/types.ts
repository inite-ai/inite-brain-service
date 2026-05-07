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

export type SetupStep = SetupFactStep | SetupMentionStep | SetupLinkStep;

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
}

// ── Metric outputs (per scenario / aggregate) ─────────────────────────

export interface QueryResult {
  query: string;
  expectedTopEntityRef: string;
  rankOfExpected: number; // 1-based; 0 means not in returned page
  topEntityRef: string | null;
  factPredicateMatched: boolean | null; // null if not asserted
  piiGatedCorrectly: boolean | null;
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

export interface ScenarioOutcome {
  scenarioId: string;
  vertical: Vertical;
  queryResults: QueryResult[];
  extractionResults: ExtractionResult[];
  identityMergeResult?: IdentityMergeResult;
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
