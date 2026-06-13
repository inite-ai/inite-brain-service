import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { runWithDebugTrace } from '../common/debug-trace';
import { IngestService } from '../ingest/ingest.service';
import { FactsService } from '../facts/facts.service';
import { EntitiesService } from '../entities/entities.service';
import { SearchService, SearchHit } from '../search/search.service';
import { SurrealService } from '../db/surreal.service';
import { allScenarios } from '../../test/eval/scenarios';
import type {
  Scenario,
  SetupStep,
  SetupFactStep,
  SetupMentionStep,
  SetupLinkStep,
  SetupRetractStep,
  SetupForgetStep,
  QueryExpectation,
} from '../../test/eval/types';

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

@Injectable()
export class ScenarioRunnerService {
  private readonly logger = new Logger(ScenarioRunnerService.name);

  constructor(
    private readonly ingest: IngestService,
    private readonly facts: FactsService,
    private readonly entities: EntitiesService,
    private readonly search: SearchService,
    private readonly surreal: SurrealService,
  ) {}

  list(): ScenarioListItem[] {
    return allScenarios.map((s) => ({
      id: s.id,
      vertical: s.vertical,
      description: s.description,
      setupSteps: s.setup.length,
      queries: s.queries.length,
      hasMemoryAssertions: !!s.memoryAssertions?.length,
      hasIdentityMerge: !!s.identityMerge,
      hasSynthesize: !!s.synthesizeQueries?.length,
    }));
  }

  getById(id: string): Scenario {
    const s = allScenarios.find((x) => x.id === id);
    if (!s) throw new NotFoundException(`Scenario ${id} not found`);
    return s;
  }

  async runOne(id: string, opts: ScenarioRunOptions = {}): Promise<ScenarioRunOutcome> {
    const scenario = this.getById(id);
    const startedAt = Date.now();
    // Ephemeral tenant id — randomUUID slice so two concurrent runs of the
    // same scenario don't collide on a ms timestamp and drop each other's DB.
    const companyId = `eval_${slugify(id)}_${randomUUID().slice(0, 8)}`;

    const setupSummary: ScenarioRunOutcome['setupSummary'] = {
      facts: 0,
      mentions: 0,
      links: 0,
      retracts: 0,
      forgets: 0,
      errors: [],
    };
    const factIdsByTag = new Map<string, string>();

    try {
      for (let i = 0; i < scenario.setup.length; i++) {
        const step = scenario.setup[i];
        try {
          await this.applyStep(companyId, step, setupSummary, factIdsByTag);
        } catch (e) {
          setupSummary.errors.push({
            step: i,
            kind: step.kind,
            error: (e as Error).message,
          });
        }
      }

      // identityMerge runs after setup (link is itself a setup step,
      // but the assertion side — resolving survivor / loser / distractor
      // entityIds and checking same-vs-distinct — only makes sense once
      // every fact has been ingested).
      const identityMergeResult = scenario.identityMerge
        ? await this.runIdentityMerge(companyId, scenario.identityMerge)
        : undefined;

      const memoryAssertionResults: MemoryAssertionResult[] = [];
      for (const a of scenario.memoryAssertions ?? []) {
        memoryAssertionResults.push(await this.runMemoryAssertion(companyId, a));
      }

      const queryResults: ScenarioQueryResult[] = [];
      for (const q of scenario.queries) {
        queryResults.push(await this.runQuery(companyId, q));
      }

      const passes = queryResults.filter((q) => q.passed).length;
      const memPassed = memoryAssertionResults.filter((r) => r.passed).length;
      const piiResults = queryResults.filter(
        (q) => q.piiGatedCorrectly !== null,
      );
      const piiPassed = piiResults.filter((q) => q.piiGatedCorrectly).length;

      const identityOk = identityMergeResult
        ? identityMergeResult.merged &&
          identityMergeResult.falseMerges.length === 0 &&
          identityMergeResult.unresolvedDistractors.length === 0
        : true;

      const passedAll =
        setupSummary.errors.length === 0 &&
        passes === queryResults.length &&
        memPassed === memoryAssertionResults.length &&
        identityOk;

      return {
        scenarioId: scenario.id,
        vertical: scenario.vertical,
        companyId,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        passed: passedAll,
        setupSummary,
        queryResults,
        memoryAssertionResults,
        identityMergeResult,
        ...(scenario.synthesizeQueries?.length
          ? {
              synthesizeSkipped: {
                count: scenario.synthesizeQueries.length,
                reason:
                  'RAGAS-style faithfulness verifier not ported to admin runner — synthesizeQueries cannot be auto-validated here yet.',
              },
            }
          : {}),
        metrics: {
          recallAt1: queryResults.length
            ? queryResults.filter((q) => q.rankOfExpected === 1).length /
              queryResults.length
            : 0,
          recallAt5: queryResults.length
            ? queryResults.filter(
                (q) => q.rankOfExpected > 0 && q.rankOfExpected <= 5,
              ).length / queryResults.length
            : 0,
          queries: queryResults.length,
          passes,
          memoryAssertionsPassed: memPassed,
          memoryAssertionsTotal: memoryAssertionResults.length,
          piiGatingPassed: piiPassed,
          piiGatingTotal: piiResults.length,
        },
      };
    } finally {
      // Always drop the ephemeral DB unless the operator explicitly asked
      // to keep it for post-mortem. A run that throws mid-flight would
      // otherwise leak its `co_eval_*` database forever.
      if (!opts.keepTenant) {
        try {
          await this.surreal.dropCompanyDatabase(companyId);
        } catch (e) {
          this.logger.warn(
            `Could not drop ephemeral tenant ${companyId}: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  async cleanupEphemeralTenants(): Promise<string[]> {
    // Best-effort: list known evals databases via the surreal admin pool.
    // No central registry exists, so we leave deletion to dropCompanyDatabase
    // calls for explicitly-known ids. This method is a stub for the v2
    // cleanup UI; for now it just reports an empty list.
    return [];
  }

  private async applyStep(
    companyId: string,
    step: SetupStep,
    summary: ScenarioRunOutcome['setupSummary'],
    factIdsByTag: Map<string, string>,
  ): Promise<void> {
    switch (step.kind) {
      case 'fact': {
        await this.applyFact(companyId, step, factIdsByTag);
        summary.facts += 1;
        break;
      }
      case 'mention': {
        await this.applyMention(companyId, step);
        summary.mentions += 1;
        break;
      }
      case 'link': {
        await this.ingest.ingestLink(companyId, {
          from: step.from,
          to: step.to,
          kind: step.linkKind,
          source: step.source,
        });
        summary.links += 1;
        break;
      }
      case 'retract': {
        await this.applyRetract(companyId, step, factIdsByTag);
        summary.retracts += 1;
        break;
      }
      case 'forget': {
        await this.applyForget(companyId, step);
        summary.forgets += 1;
        break;
      }
    }
  }

  private async applyFact(
    companyId: string,
    step: SetupFactStep,
    factIdsByTag: Map<string, string>,
  ): Promise<void> {
    const res = await this.ingest.ingestFact(companyId, {
      entityRef: step.entityRef,
      predicate: step.predicate,
      object: step.object,
      validFrom: step.validFrom,
      validUntil: step.validUntil,
      confidence: step.confidence,
      source: step.source,
    });
    if (step.tag && res.factId) factIdsByTag.set(step.tag, res.factId);
  }

  private async applyMention(
    companyId: string,
    step: SetupMentionStep,
  ): Promise<void> {
    await this.ingest.ingestMention(companyId, {
      text: step.text,
      contextRef: step.contextRef,
      knownEntities: step.knownEntities,
      emittedAt: step.emittedAt,
    });
  }

  private async applyRetract(
    companyId: string,
    step: SetupRetractStep,
    factIdsByTag: Map<string, string>,
  ): Promise<void> {
    const factId = factIdsByTag.get(step.tag);
    if (!factId) {
      throw new Error(`Retract references unknown tag '${step.tag}'`);
    }
    await this.facts.retract(companyId, factId, {
      reason: step.reason,
      retractedBy: { source: 'system' },
    });
  }

  private async applyForget(
    companyId: string,
    step: SetupForgetStep,
  ): Promise<void> {
    // Resolve entityId via search-by-externalRef (lightweight — we
    // could read entity_external_ref directly, but the helper search
    // path is sufficient for the eval scale).
    const refKey = `${safe(step.entityRef.vertical)}__${safe(step.entityRef.id)}`;
    const hit = await this.findEntityByExternalRef(companyId, refKey);
    if (!hit) {
      throw new Error(`Forget could not resolve ${refKey}`);
    }
    await this.entities.forget(companyId, hit, {
      reason: step.reason,
      requestId: step.requestId,
    });
  }

  private async findEntityByExternalRef(
    companyId: string,
    refKey: string,
  ): Promise<string | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT VALUE entity FROM entity_external_ref WHERE key = $key LIMIT 1`,
        { key: refKey },
      );
      const arr = (rows as any[]) ?? [];
      return arr[0] ? String(arr[0]) : null;
    });
  }

  private async runQuery(
    companyId: string,
    expectation: QueryExpectation,
  ): Promise<ScenarioQueryResult> {
    const t0 = Date.now();
    const isPiiGated = expectation.mustNotLeakPredicate !== undefined;
    // PII-gating expectations simulate a non-PII caller — brain strips
    // read_pii-scoped facts server-side, so the gated predicate must NOT
    // come back. Non-gated queries default to the full-access scope set.
    const callerScopes =
      expectation.callerScopes ??
      (isPiiGated ? ['brain:read'] : ['brain:read', 'brain:read_pii']);

    let hits: SearchHit[] = [];
    let error: string | undefined;
    let traceCapture:
      | { requestId: string; totalMs: number; spans: any[] }
      | undefined;
    try {
      // Capture the in-process debug trace so the demo deck can render
      // the per-stage waterfall (vector / lexical / fusion / reranker).
      const captured = await runWithDebugTrace(() =>
        this.search.search(
          companyId,
          {
            query: expectation.query,
            limit: 10,
            asOf: expectation.asOf,
            ...(expectation.predicates ? { predicates: expectation.predicates } : {}),
          } as any,
          callerScopes as any,
        ),
      );
      hits = captured.result.results;
      traceCapture = {
        requestId: captured.trace.requestId,
        totalMs: captured.trace.totalMs,
        spans: captured.trace.spans.map((s) => ({
          id: s.id,
          parentId: s.parentId,
          name: s.name,
          startedAt: s.startedAt,
          durationMs: s.durationMs,
          ...(s.error ? { error: s.error } : {}),
        })),
      };
    } catch (e) {
      error = (e as Error).message;
    }

    const [vertical, id] = expectation.expectedTopEntityRef.split('.', 2);
    const refTag = `${safe(vertical)}__${safe(id)}`;
    const rank = hits.findIndex((r) => r.externalRefs?.[refTag] === id);
    const rankOfExpected = rank === -1 ? 0 : rank + 1;
    const top = hits[0] ?? null;
    const topEntityRef = top
      ? formatTopRef(top.externalRefs)
      : null;

    const factPredicateMatched =
      expectation.expectedFactPredicate && rankOfExpected > 0
        ? hits[rankOfExpected - 1].facts.some(
            (f) => f.predicate === expectation.expectedFactPredicate,
          )
        : null;

    // Fact-level PII gating verdict — mirrors test/eval/runner/query-executor.
    // Vacuously safe when the entity didn't surface at all. Leak iff the
    // matched entity carries a fact with the gated predicate.
    let piiGatedCorrectly: boolean | null = null;
    if (isPiiGated) {
      const hit = rankOfExpected > 0 ? hits[rankOfExpected - 1] : null;
      const leaked = hit?.facts.some(
        (f) => f.predicate === expectation.mustNotLeakPredicate,
      );
      piiGatedCorrectly = !leaked;
    }

    const passed =
      !error &&
      rankOfExpected === 1 &&
      (factPredicateMatched === null ? true : factPredicateMatched) &&
      (piiGatedCorrectly === null ? true : piiGatedCorrectly);

    return {
      query: expectation.query,
      expectedTopEntityRef: expectation.expectedTopEntityRef,
      rankOfExpected,
      topEntityRef,
      factPredicateMatched,
      asOf: expectation.asOf,
      durationMs: Date.now() - t0,
      hitCount: hits.length,
      topHits: hits.slice(0, 3).map((h) => ({
        entityId: h.entityId,
        canonicalName: h.canonicalName,
        score: h.score,
        externalRefs: h.externalRefs ?? {},
        facts: (h.facts ?? []).slice(0, 5).map((f) => ({
          factId: f.factId,
          predicate: f.predicate,
          object: f.object,
          status: f.status,
          validFrom: f.validFrom,
          ...(f.validUntil ? { validUntil: f.validUntil } : {}),
        })),
      })),
      passed,
      piiGatedCorrectly,
      ...(expectation.mustNotLeakPredicate
        ? { mustNotLeakPredicate: expectation.mustNotLeakPredicate }
        : {}),
      ...(error ? { error } : {}),
      ...(traceCapture ? { trace: traceCapture } : {}),
    };
  }

  // ── Memory-lifecycle assertions ────────────────────────────────────
  // After-setup invariants. Each assertion is independent — a failure
  // doesn't short-circuit the rest. Mirrors test/eval/runner/memory-
  // assertions.ts but talks directly to SearchService instead of through
  // the SDK so it stays in-process.

  private async runMemoryAssertion(
    companyId: string,
    a: NonNullable<Scenario['memoryAssertions']>[number],
  ): Promise<MemoryAssertionResult> {
    const t0 = Date.now();
    const finalize = (
      passed: boolean,
      detail?: string,
    ): MemoryAssertionResult => ({
      description: a.description,
      kind: a.kind,
      passed,
      detail,
      durationMs: Date.now() - t0,
    });

    try {
      if (!a.query) {
        return finalize(false, 'assertion missing query');
      }

      const res = await this.search.search(
        companyId,
        {
          query: a.query,
          limit: 20,
          asOf: a.asOf,
          includeRetracted: a.includeRetracted ?? false,
        } as any,
        ['brain:read', 'brain:read_pii'] as any,
      );

      if (a.kind === 'no_search_match') {
        if (!a.expectedRefAbsent) return finalize(false, 'missing expectedRefAbsent');
        const refTag = parseRefTag(a.expectedRefAbsent);
        const matched = res.results.find(
          (r) => r.externalRefs && r.externalRefs[refTag.refKey] === refTag.id,
        );
        if (matched) {
          return finalize(
            false,
            `expected '${a.expectedRefAbsent}' to be absent but surfaced (canonicalName=${matched.canonicalName})`,
          );
        }
        return finalize(true);
      }

      if (a.kind === 'search_object_present') {
        if (!a.expectedRefPresent || !a.objectSubstring) {
          return finalize(false, 'missing expectedRefPresent or objectSubstring');
        }
        const refTag = parseRefTag(a.expectedRefPresent);
        const matched = res.results.find(
          (r) => r.externalRefs && r.externalRefs[refTag.refKey] === refTag.id,
        );
        if (!matched) {
          return finalize(
            false,
            `expected '${a.expectedRefPresent}' to surface but did not (top=${res.results[0]?.canonicalName ?? 'none'})`,
          );
        }
        const needle = a.objectSubstring.toLowerCase();
        const hasObj = matched.facts.some((f) =>
          f.object.toLowerCase().includes(needle),
        );
        if (!hasObj) {
          return finalize(
            false,
            `'${a.expectedRefPresent}' surfaced but no fact object matched substring '${a.objectSubstring}'`,
          );
        }
        return finalize(true);
      }

      // search_object_absent
      if (!a.expectedRefAbsent || !a.objectSubstring) {
        return finalize(false, 'missing expectedRefAbsent or objectSubstring');
      }
      const refTag = parseRefTag(a.expectedRefAbsent);
      const matched = res.results.find(
        (r) => r.externalRefs && r.externalRefs[refTag.refKey] === refTag.id,
      );
      if (!matched) return finalize(true);
      const needle = a.objectSubstring.toLowerCase();
      const offending = matched.facts.find((f) =>
        f.object.toLowerCase().includes(needle),
      );
      if (offending) {
        return finalize(
          false,
          `'${a.expectedRefAbsent}' should not have surfaced fact containing '${a.objectSubstring}' but did (factId=${offending.factId} status=${offending.status})`,
        );
      }
      return finalize(true);
    } catch (e) {
      return finalize(false, `assertion threw: ${(e as Error).message}`);
    }
  }

  // ── Identity-merge assertion ───────────────────────────────────────
  // Resolves survivor + loser by externalRef. After setup (which already
  // contains the identity_of link as a SetupLinkStep), brain's search-side
  // re-attribution surfaces survivor + loser as the SAME entityId. We then
  // walk shouldNotMerge distractors and assert they resolve to different
  // entityIds — guards against over-merge regressions.

  private async runIdentityMerge(
    companyId: string,
    merge: NonNullable<Scenario['identityMerge']>,
  ): Promise<IdentityMergeOutcomeShape> {
    const survivor = await this.findEntityIdByRef(companyId, merge.survivorRef);
    const loser = await this.findEntityIdByRef(companyId, merge.loserRef);
    if (!survivor || !loser) {
      return {
        survivorRef: merge.survivorRef,
        loserRef: merge.loserRef,
        merged: false,
        falseMerges: [],
        unresolvedDistractors: merge.shouldNotMerge ?? [],
        detail: 'could not resolve survivor or loser externalRef',
      };
    }

    const merged = survivor === loser;
    const falseMerges: string[] = [];
    const unresolvedDistractors: string[] = [];
    for (const ref of merge.shouldNotMerge ?? []) {
      const distractor = await this.findEntityIdByRef(companyId, ref);
      if (!distractor) {
        unresolvedDistractors.push(ref);
        continue;
      }
      if (distractor === survivor) falseMerges.push(ref);
    }

    return {
      survivorRef: merge.survivorRef,
      loserRef: merge.loserRef,
      merged,
      falseMerges,
      unresolvedDistractors,
    };
  }

  private async findEntityIdByRef(
    companyId: string,
    ref: string,
  ): Promise<string | null> {
    const [vertical, id] = ref.split('.', 2);
    const refTag = `${safe(vertical)}__${safe(id)}`;
    try {
      const res = await this.search.search(
        companyId,
        { query: id, limit: 10 } as any,
        ['brain:read', 'brain:read_pii'] as any,
      );
      const hit = res.results.find((r) => r.externalRefs?.[refTag] === id);
      return hit?.entityId ?? null;
    } catch {
      return null;
    }
  }
}

function parseRefTag(ref: string): { refKey: string; id: string } {
  const [vertical, id] = ref.split('.', 2);
  return { refKey: `${safe(vertical)}__${safe(id)}`, id };
}

function formatTopRef(refs: Record<string, string> | undefined): string | null {
  if (!refs) return null;
  const entries = Object.entries(refs);
  if (entries.length === 0) return null;
  const [k, v] = entries[0];
  const dot = k.indexOf('__');
  if (dot === -1) return `${k}.${v}`;
  return `${k.slice(0, dot)}.${v}`;
}

function safe(s: string): string {
  return s.replace(/\./g, '__');
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40);
}
