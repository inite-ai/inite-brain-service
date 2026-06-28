import { Injectable, Logger } from '@nestjs/common';
import { runWithDebugTrace } from '../common/debug-trace';
import { SearchService, SearchHit } from '../search/search.service';
import type { Scenario, QueryExpectation } from '../eval/types';
import type {
  ScenarioQueryResult,
  MemoryAssertionResult,
  IdentityMergeOutcomeShape,
} from './scenario-runner.types';
import { parseRefTag, formatTopRef, safe } from './scenario-runner-utils';

/**
 * Evaluation phase of a scenario run: everything that reads back through
 * SearchService — query expectations (with the per-stage debug trace),
 * memory-lifecycle assertions, and the identity-merge verdict. Single
 * SearchService dep.
 */
@Injectable()
export class ScenarioEvalService {
  private readonly logger = new Logger(ScenarioEvalService.name);

  constructor(private readonly search: SearchService) {}

  async runQuery(
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
    const topEntityRef = top ? formatTopRef(top.externalRefs) : null;

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

  async runMemoryAssertion(
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

  async runIdentityMerge(
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
    const [, id] = ref.split('.', 2);
    const refTag = parseRefTag(ref).refKey;
    try {
      const res = await this.search.search(
        companyId,
        { query: id, limit: 10 } as any,
        ['brain:read', 'brain:read_pii'] as any,
      );
      const hit = res.results.find((r) => r.externalRefs?.[refTag] === id);
      return hit?.entityId ?? null;
    } catch (e) {
      this.logger.debug(
        `scenario externalRef lookup failed (${refTag}=${id}): ${(e as Error).message ?? e}`,
      );
      return null;
    }
  }
}
