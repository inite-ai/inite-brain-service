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
   * Optional predicate filter passed straight to search.dto.predicates.
   * Use when the test wants to isolate one fact dimension from
   * ranking noise — e.g. a bitemporal-cutoff test that needs to see
   * the address fact regardless of whether the name fact outranks it
   * lexically. Without this, search returns matched facts only and a
   * weak query against a strong name-match can hide the bitemporal
   * slice the test is meant to check.
   */
  predicates?: string[];
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

// ── Synthesize (corrective-RAG) faithfulness expectations ─────────────
//
// Each synthesizeQuery runs /v1/synthesize against the configured
// scenarios and pipes the (answer, citations) tuple through the
// RAGAS-style claim-decomposed verifier (test/eval/metrics/faithfulness.ts).
// Aggregated as `faithfulness:mean` and `faithfulness:verifier-failures`.

export interface SynthesizeExpectation {
  /** Free-text query handed to /v1/synthesize. */
  query: string;
  /**
   * Soft floor: faithfulness score must clear this threshold for the
   * scenario to count as a pass. Default 0.85 (RAGAS production
   * convention — keeps paraphrase noise out without blocking on
   * minor wording).
   */
  faithfulnessFloor?: number;
  /**
   * If true, an empty/null answer (synthesizer rejected for lack of
   * grounded evidence) is treated as a pass — used when the test
   * setup is intentionally thin and we want to validate the
   * guardrail engaged rather than the answer quality. Default false.
   */
  allowEmptyAnswer?: boolean;
  /**
   * Optional asOf for bitemporal synthesize.
   */
  asOf?: string;
  /**
   * Optional caller scopes — same semantics as QueryExpectation.callerScopes.
   * The runner does NOT switch clients on this for synthesize; the field
   * is reserved for future use.
   */
  callerScopes?: Array<'brain:read' | 'brain:write' | 'brain:read_pii' | 'brain:admin'>;
  /**
   * Phase 4.C locale-pinning gate. When set, the answer's detected
   * language MUST equal this ISO 639-1 code. The aggregator surfaces
   * `answer-language-correctness` as a hard threshold (1.0 — any
   * single mismatch fails the gate). When omitted no language
   * assertion runs and the per-query result carries null for the
   * fidelity flag, which the aggregator drops from the average.
   */
  expectedAnswerLang?: string;
}

export interface SynthesizeOutcome {
  scenarioId: string;
  query: string;
  /** null when synthesizer rejected (no grounded evidence). */
  answer: string | null;
  /**
   * The reason the synthesizer surfaced — relevant when answer is null.
   * Mirrors brain's SynthesisReason without coupling the harness to
   * the SDK enum.
   */
  reason?: string;
  /** RAGAS faithfulness score for the answer; null when no answer. */
  faithfulness: number | null;
  /** N atomic claims the verifier evaluated. */
  totalClaims: number;
  /**
   * Set when the verifier returned a malformed response. Surfaced as
   * a separate metric so a half-broken LLM call doesn't masquerade
   * as low faithfulness.
   */
  verifierFailureKind?: 'length_mismatch' | 'invalid_verdicts' | 'exception';
  /** Pass = answer present (or allowEmptyAnswer) AND faithfulness ≥ floor AND no verifier failure. */
  passed: boolean;
  /** Floor that was applied — surfaced for the report. */
  faithfulnessFloor: number;
  /**
   * Phase 4.C — language detected on the synthesized answer (ISO
   * 639-1). null when the answer was empty or detection returned
   * 'und'. Compared by the aggregator against
   * SynthesizeExpectation.expectedAnswerLang when that's set.
   */
  answerLangDetected?: string | null;
  /**
   * Per-query language fidelity flag. true when expectedAnswerLang
   * is set AND answerLangDetected matches; false on mismatch;
   * undefined when no expectation was declared (drops from the
   * aggregate, so locale-agnostic scenarios don't dilute the
   * mismatch rate).
   */
  answerLangCorrect?: boolean;
  /**
   * Phase 2 (DecisionLog) — number of citations the generator emitted
   * inline. 0 means the answer was un-cited; this is a soft signal —
   * aggregated as a rate, not gated per-query.
   */
  decisionLogCitationCount?: number;
  /**
   * Phase 3.B — mean extractionEntropy across the SearchHit facts the
   * generator was given as context. null when no fact carried an
   * entropy field (i.e. when EXTRACTOR_SC_PASSES=1 in the corpus).
   */
  avgExtractionEntropy?: number | null;
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
   * Optional `shouldNotMerge` lists distractor refs that must remain
   * distinct from the survivor — used to compute identity-resolution
   * precision (a metric blind to false merges is placebo).
   */
  identityMerge?: {
    survivorRef: string; // '<vertical>.<id>'
    loserRef: string;
    /**
     * Refs that must NOT be merged into the survivor. Each one is
     * checked AFTER the identity_of link is created: the harness
     * resolves the distractor's entityId and asserts it is different
     * from the survivor's entityId. Resolution failure (the distractor
     * has no facts ingested) is treated as a setup error, not a pass.
     */
    shouldNotMerge?: string[];
  };
  /**
   * Optional memory-lifecycle assertions. Run AFTER setup, BEFORE
   * queries. Aggregated into the `memory-lifecycle-correctness`
   * metric — % assertions that passed across the suite.
   */
  memoryAssertions?: MemoryAssertion[];
  /**
   * Optional MIA (Membership Inference Attack) tests. Run AFTER
   * memoryAssertions, BEFORE queries. Each test computes AUC over
   * top-hit scores for forgotten names vs control names; aggregated
   * into the `privacy-leakage-mia-auc` metric.
   */
  miaTests?: MiaTest[];
  /**
   * Optional synthesize queries — run AFTER queries. Each one fires
   * /v1/synthesize and pipes (answer, citations) through the
   * RAGAS-style faithfulness verifier. Aggregated as
   * `faithfulness:mean` and `faithfulness:verifier-failures`.
   */
  synthesizeQueries?: SynthesizeExpectation[];
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
  /**
   * The expectedFactPredicate that was asserted (if any). Carried on
   * the result so the reporter can group queries by predicate and
   * surface "router weak on dob" without re-walking the scenarios.
   */
  expectedFactPredicate?: string;
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
  /** True when the survivor↔loser identity_of link was accepted. */
  merged: boolean;
  /**
   * Refs from the scenario's shouldNotMerge list that the harness
   * resolved to the SAME entity as the survivor — i.e. brain over-merged.
   * Empty when no distractors were declared OR no over-merge happened.
   */
  falseMerges: string[];
  /**
   * Refs from shouldNotMerge that could not be resolved (no entity
   * surfaced for the externalRef). Surfaced as a setup-misconfig signal
   * so a distractor with no ingested facts doesn't masquerade as a pass.
   */
  unresolvedDistractors: string[];
}

export interface MemoryAssertionResult {
  scenarioId: string;
  description: string;
  kind: MemoryAssertion['kind'];
  passed: boolean;
  /** Short detail for the report (e.g. "search returned cust_42 unexpectedly"). */
  detail?: string;
}

// ── Privacy-leakage / MIA test ────────────────────────────────────────
// MUSE-aligned "did we actually forget" check. Run AFTER setup
// (forgets included) so the score distributions reflect post-forget
// state. The harness queries each name and records the top-hit score;
// the metric layer computes AUC over the two distributions.

export interface MiaTest {
  /** Free-text label surfaced in the report. */
  description: string;
  /**
   * Names of entities we've forgotten. We expect search-by-name on
   * these to return low scores (entity vanished, no residual cluster).
   */
  forgottenNames: string[];
  /**
   * Random names that were NEVER ingested. Distributional control —
   * if forgotten and control distributions look the same, the
   * forget cascade is regulatorily clean.
   */
  controlNames: string[];
  /**
   * AUC pass threshold. Default 0.6 (MUSE convention). AUC > threshold
   * is a legal-finding-grade leak.
   */
  threshold?: number;
}

export interface MiaTestResult {
  scenarioId: string;
  description: string;
  auc: number;
  threshold: number;
  passed: boolean;
  forgottenN: number;
  controlN: number;
  /**
   * True when forgottenN+controlN < MIA_MIN_N (default 30). The
   * Mann-Whitney AUC on tiny N is statistically indistinguishable
   * from 0.5 noise — gating on it produces false positives. When set,
   * the harness still computes AUC for visibility but flips `passed`
   * to true regardless of threshold and surfaces an underpowered
   * note. This matches the audit recommendation in the eval roadmap.
   */
  underpowered?: boolean;
  detail?: string;
}

export interface ScenarioOutcome {
  scenarioId: string;
  vertical: Vertical;
  queryResults: QueryResult[];
  extractionResults: ExtractionResult[];
  identityMergeResult?: IdentityMergeResult;
  memoryAssertionResults: MemoryAssertionResult[];
  miaTestResults: MiaTestResult[];
  synthesizeOutcomes: SynthesizeOutcome[];
}

export interface AggregateMetric {
  name: string;
  /** null = no data for this metric in this slice (e.g. no mentions to score) */
  value: number | null;
  threshold?: number;
  unit?: string;
  /**
   * Optional 95% bootstrap CI for sample-mean metrics (recall@k, MRR,
   * NDCG). null bounds when N<2 or no resamples done. Surfaced by
   * Reporter as "0.949 [0.91-0.98]" so a 1pp delta on N=5 reads as
   * "well within CI" instead of "regression".
   */
  ciLower?: number | null;
  ciUpper?: number | null;
  /** Sample size — N for the metric. Reported alongside CI for honesty. */
  n?: number;
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
