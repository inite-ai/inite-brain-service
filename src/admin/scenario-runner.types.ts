export interface ScenarioListItem {
  id: string;
  vertical: string;
  description: string;
  setupSteps: number;
  queries: number;
  hasMemoryAssertions: boolean;
  hasIdentityMerge: boolean;
  hasSynthesize: boolean;
}

export interface ScenarioQueryResult {
  query: string;
  expectedTopEntityRef: string;
  rankOfExpected: number;
  topEntityRef: string | null;
  factPredicateMatched: boolean | null;
  asOf?: string;
  durationMs: number;
  hitCount: number;
  topHits: Array<{
    entityId: string;
    canonicalName: string;
    score: number;
    externalRefs: Record<string, string>;
    /**
     * Facts brain surfaced for this entity at the asOf cursor. The demo
     * deck shows these as the actual answer (eg. plan=growth) — the
     * canonicalName is only the entity that carries the fact.
     */
    facts: Array<{
      factId: string;
      predicate: string;
      object: string;
      status: string;
      validFrom: string;
      validUntil?: string;
    }>;
  }>;
  passed: boolean;
  /**
   * PII-gating outcome. null when the expectation didn't declare
   * mustNotLeakPredicate; true iff the gated predicate did NOT surface
   * under the matched entity when called with a limited-scope caller.
   */
  piiGatedCorrectly: boolean | null;
  /** The gated predicate the scenario asserted (when applicable). */
  mustNotLeakPredicate?: string;
  /** Set when the search call itself threw — diagnostic context for passed:false. */
  error?: string;
  /**
   * Per-stage trace from the in-process debug-trace ALS. Surfaced for the
   * demo deck so the presenter can show the retrieval pipeline (vector
   * leg / lexical leg / fusion / reranker) as bars on a waterfall.
   */
  trace?: {
    requestId: string;
    totalMs: number;
    spans: Array<{
      id: string;
      parentId?: string;
      name: string;
      startedAt: number;
      durationMs?: number;
      error?: string;
    }>;
  };
}

export interface MemoryAssertionResult {
  description: string;
  kind: 'no_search_match' | 'search_object_present' | 'search_object_absent';
  passed: boolean;
  detail?: string;
  durationMs: number;
}

export interface IdentityMergeOutcomeShape {
  survivorRef: string;
  loserRef: string;
  merged: boolean;
  falseMerges: string[];
  unresolvedDistractors: string[];
  detail?: string;
}

export interface ScenarioRunOutcome {
  scenarioId: string;
  vertical: string;
  companyId: string;
  startedAt: string;
  durationMs: number;
  passed: boolean;
  setupSummary: {
    facts: number;
    mentions: number;
    links: number;
    retracts: number;
    forgets: number;
    errors: Array<{ step: number; kind: string; error: string }>;
  };
  queryResults: ScenarioQueryResult[];
  memoryAssertionResults: MemoryAssertionResult[];
  identityMergeResult?: IdentityMergeOutcomeShape;
  /**
   * Synthesize-faithfulness verification (RAGAS-style claim decomposition)
   * is not implemented in the admin runner — it lives in test/eval/runner/
   * faithfulness-checker which requires the SDK + an Anthropic verifier
   * model. When a scenario declares synthesizeQueries we surface them as
   * skipped here so the UI can render an honest "not validated" badge
   * instead of pretending the run was complete.
   */
  synthesizeSkipped?: { count: number; reason: string };
  metrics: {
    recallAt1: number;
    recallAt5: number;
    queries: number;
    passes: number;
    memoryAssertionsPassed: number;
    memoryAssertionsTotal: number;
    piiGatingPassed: number;
    piiGatingTotal: number;
  };
}

export interface ScenarioRunOptions {
  /**
   * If true, the ephemeral `eval_*` tenant database is kept after the run
   * (debug aid). Default false — runs always create+drop an isolated tenant
   * so a destructive setup step (retract/forget) can never mutate a live
   * tenant. There is no escape hatch to target an arbitrary companyId by
   * design.
   */
  keepTenant?: boolean;
}
