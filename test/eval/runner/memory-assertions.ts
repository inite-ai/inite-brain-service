import type { BrainClient } from '@inite/knowledge';
import type { MemoryAssertion, MemoryAssertionResult, Scenario } from '../types';

/**
 * MemoryAssertionsChecker — runs the lifecycle assertions declared on
 * a scenario AFTER setup, BEFORE queries. Pure read-side: every check
 * is a search call.
 *
 * Why search-only checks for forget / retract / update:
 *   - `no_search_match` covers entity-level forgets (entity vanishes
 *     from every search angle) and fact-level retracts (the retracted
 *     fact's evidence does not surface for the owning entity).
 *   - `search_object_*` covers update / supersede semantics — after
 *     ingesting tier=platinum on top of tier=gold, the platinum
 *     object should be the one search returns.
 *
 * No SDK-level entity GET — the public read surface for "is this
 * entity gone" is the search miss; deeper introspection (timeline,
 * tombstone) is covered by other unit/e2e tests, not the eval-runner.
 *
 * Each assertion is independent — a failure on assertion N does NOT
 * short-circuit assertion N+1. The aggregator computes the
 * memory-lifecycle-correctness metric as fraction passed.
 */
export class MemoryAssertionsChecker {
  constructor(private readonly brain: BrainClient) {}

  async check(scenario: Scenario): Promise<MemoryAssertionResult[]> {
    const assertions = scenario.memoryAssertions ?? [];
    const out: MemoryAssertionResult[] = [];
    for (const a of assertions) {
      out.push(await this.runOne(scenario.id, a));
    }
    return out;
  }

  private async runOne(
    scenarioId: string,
    a: MemoryAssertion,
  ): Promise<MemoryAssertionResult> {
    try {
      switch (a.kind) {
        case 'no_search_match':
          return await this.checkNoSearchMatch(scenarioId, a);
        case 'search_object_present':
          return await this.checkObjectPresent(scenarioId, a);
        case 'search_object_absent':
          return await this.checkObjectAbsent(scenarioId, a);
      }
    } catch (err) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail: `assertion threw: ${(err as Error).message}`,
      };
    }
  }

  private async checkNoSearchMatch(
    scenarioId: string,
    a: MemoryAssertion,
  ): Promise<MemoryAssertionResult> {
    if (!a.query || !a.expectedRefAbsent) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail: 'assertion missing query or expectedRefAbsent',
      };
    }
    const res = await this.brain.search({
      query: a.query,
      limit: 20,
      asOf: a.asOf,
      includeRetracted: a.includeRetracted ?? false,
    });
    const refTag = parseRefTag(a.expectedRefAbsent);
    const matched = res.results.find(
      (r) => r.externalRefs && r.externalRefs[refTag.refKey] === refTag.id,
    );
    if (matched) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail: `expected '${a.expectedRefAbsent}' to be absent but it surfaced (canonicalName=${matched.canonicalName})`,
      };
    }
    return {
      scenarioId,
      description: a.description,
      kind: a.kind,
      passed: true,
    };
  }

  private async checkObjectPresent(
    scenarioId: string,
    a: MemoryAssertion,
  ): Promise<MemoryAssertionResult> {
    if (!a.query || !a.expectedRefPresent || !a.objectSubstring) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail:
          'assertion missing query, expectedRefPresent, or objectSubstring',
      };
    }
    const res = await this.brain.search({
      query: a.query,
      limit: 20,
      asOf: a.asOf,
      includeRetracted: a.includeRetracted ?? false,
    });
    const refTag = parseRefTag(a.expectedRefPresent);
    const matched = res.results.find(
      (r) => r.externalRefs && r.externalRefs[refTag.refKey] === refTag.id,
    );
    if (!matched) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail: `expected '${a.expectedRefPresent}' to surface but it did not (top=${res.results[0]?.canonicalName ?? 'none'})`,
      };
    }
    const needle = a.objectSubstring.toLowerCase();
    const hasObj = matched.facts.some((f) =>
      f.object.toLowerCase().includes(needle),
    );
    if (!hasObj) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail: `'${a.expectedRefPresent}' surfaced but no fact object matched substring '${a.objectSubstring}' (saw ${matched.facts.map((f) => f.object).join(', ')})`,
      };
    }
    return {
      scenarioId,
      description: a.description,
      kind: a.kind,
      passed: true,
    };
  }

  private async checkObjectAbsent(
    scenarioId: string,
    a: MemoryAssertion,
  ): Promise<MemoryAssertionResult> {
    if (!a.query || !a.expectedRefAbsent || !a.objectSubstring) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail:
          'assertion missing query, expectedRefAbsent, or objectSubstring',
      };
    }
    const res = await this.brain.search({
      query: a.query,
      limit: 20,
      asOf: a.asOf,
      includeRetracted: a.includeRetracted ?? false,
    });
    const refTag = parseRefTag(a.expectedRefAbsent);
    const matched = res.results.find(
      (r) => r.externalRefs && r.externalRefs[refTag.refKey] === refTag.id,
    );
    if (!matched) {
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: true,
      };
    }
    const needle = a.objectSubstring.toLowerCase();
    const offending = matched.facts.find((f) =>
      f.object.toLowerCase().includes(needle),
    );
    if (offending) {
      // DEBUG: dump every fact on the matched entity so we can see
      // status / validUntil and figure out whether the leak is from
      // an unfiltered superseded fact or from a setup-step that
      // never produced the retraction.
      if (process.env.DEBUG_MEMLC === '1') {
        // eslint-disable-next-line no-console
        console.log(
          `[memlc-debug] scenarioId=${scenarioId} description='${a.description}' query='${a.query}'`,
        );
        for (const f of matched.facts) {
          // eslint-disable-next-line no-console
          console.log(
            `  factId=${f.factId} predicate=${f.predicate} object='${f.object}' status=${f.status} validFrom=${f.validFrom} validUntil=${f.validUntil ?? '-'} score=${f.score}`,
          );
        }
      }
      return {
        scenarioId,
        description: a.description,
        kind: a.kind,
        passed: false,
        detail: `'${a.expectedRefAbsent}' should not have surfaced fact object containing '${a.objectSubstring}', but it did (offending factId=${offending.factId} status=${offending.status})`,
      };
    }
    return {
      scenarioId,
      description: a.description,
      kind: a.kind,
      passed: true,
    };
  }
}

/**
 * Decompose a '<vertical>.<id>' externalRef into the lookup-shape
 * brain returns on search.results[].externalRefs.
 */
function parseRefTag(ref: string): { refKey: string; id: string } {
  const [vertical, id] = ref.split('.', 2);
  return { refKey: `${vertical}__${id}`, id };
}
