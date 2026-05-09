import type { BrainClient } from '@inite/knowledge';
import type { QueryExpectation, QueryResult } from '../types';

/**
 * Executes a single query expectation against brain and produces a
 * QueryResult. No scoring math here — that lives in metrics/.
 *
 * For PII-gating queries (mustBeAbsent), uses a separately-scoped
 * BrainClient if provided; otherwise reuses the default.
 */
export class QueryExecutor {
  constructor(
    private readonly defaultClient: BrainClient,
    private readonly limitedClient: BrainClient,
  ) {}

  async execute(expectation: QueryExpectation): Promise<QueryResult> {
    const isPiiGated = expectation.mustNotLeakPredicate !== undefined;
    const client = isPiiGated ? this.limitedClient : this.defaultClient;
    const res = await client.search({
      query: expectation.query,
      limit: 10,
      asOf: expectation.asOf,
    });
    const [vertical, id] = expectation.expectedTopEntityRef.split('.', 2);
    const refTag = `${vertical}__${id}`;

    const rank = res.results.findIndex((r) => r.externalRefs?.[refTag] === id);
    const rankOfExpected = rank === -1 ? 0 : rank + 1;
    const topEntityRef = this.formatTopRef(res.results[0]?.externalRefs ?? null);

    const factPredicateMatched =
      expectation.expectedFactPredicate && rankOfExpected > 0
        ? res.results[rankOfExpected - 1].facts.some(
            (f) => f.predicate === expectation.expectedFactPredicate,
          )
        : null;

    // Fact-level PII gating: correct iff no fact under the expected
    // entity in the response carries the gated predicate. Absence of
    // the entity entirely also counts as correct (vacuously safe).
    let piiGatedCorrectly: boolean | null = null;
    if (isPiiGated) {
      const hit =
        rankOfExpected > 0 ? res.results[rankOfExpected - 1] : null;
      const leaked = hit?.facts.some(
        (f) => f.predicate === expectation.mustNotLeakPredicate,
      );
      piiGatedCorrectly = !leaked;
    }

    return {
      query: expectation.query,
      expectedTopEntityRef: expectation.expectedTopEntityRef,
      rankOfExpected,
      topEntityRef,
      factPredicateMatched,
      piiGatedCorrectly,
      temporal: expectation.asOf !== undefined,
    };
  }

  private formatTopRef(refs: Record<string, string> | null): string | null {
    if (!refs) return null;
    const entries = Object.entries(refs);
    if (entries.length === 0) return null;
    return entries.map(([k, v]) => `${k.replace('__', '.')}=${v}`).join(',');
  }
}
