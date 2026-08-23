import { composePredicateId, PACK_NAMESPACE_SEP } from './manifest';

/**
 * Domain Pack eval fixtures (docs/domain-packs.md). A pack may ship small,
 * self-describing extraction test cases — an input text + what the extractor
 * should surface for this pack's domain. Consumed at runtime: an operator runs
 * `POST /v1/admin/packs/:packId/eval` to check the LIVE extractor (with the
 * pack's predicates + extractionProfile active) still meets the pack's own
 * expectations for this tenant. Mirrors how `extractionProfile` was wired:
 * manifest → install → domain_pack → run + score.
 */

/** One expected fact a fixture asserts must surface. */
export interface EvalFixtureExpectFact {
  /** Predicate id. Bare (`zoned_as`) is resolved against the pack namespace
   *  (`<packId>__zoned_as`); an already-namespaced id (contains `__`) is used
   *  verbatim — so a fixture can also assert a core predicate. */
  predicate: string;
  /** Optional case-insensitive substring the extracted object must contain. */
  objectIncludes?: string;
}

export interface EvalFixture {
  /** Unique within the pack. */
  id: string;
  description?: string;
  /** Input mention text run through the extractor. */
  text: string;
  expect: {
    /** Each listed fact must appear in the extraction. */
    facts?: EvalFixtureExpectFact[];
    minEntities?: number;
    minFacts?: number;
  };
}

/** OpenAPI mirror: src/contracts/admin/packs.schema.ts
 *  (PackEvalFixtureResultSchema / PackEvalReportSchema) — keep in lockstep. */
export interface EvalFixtureResult {
  id: string;
  passed: boolean;
  /** Human-readable reasons a fixture failed (empty when passed). */
  failures: string[];
}

export interface PackEvalReport {
  packId: string;
  version: string;
  total: number;
  passed: number;
  results: EvalFixtureResult[];
}

/** Minimal shape of an extraction result the scorer needs (decoupled from the
 *  extractor module so this stays a pure, dependency-light domain-packs util). */
export interface ScorableExtraction {
  entities: unknown[];
  facts: Array<{ predicate: string; object: string }>;
}

/** Resolve a fixture predicate to its stored id. */
function resolvePredicate(packId: string, predicate: string): string {
  return predicate.includes(PACK_NAMESPACE_SEP) ? predicate : composePredicateId(packId, predicate);
}

/** Score one fixture against an extraction. Pure — the runtime service supplies
 *  the extraction; this is unit-testable without the extractor/DB. */
export function scoreFixture(
  packId: string,
  fixture: EvalFixture,
  extraction: ScorableExtraction,
): EvalFixtureResult {
  const failures: string[] = [];
  for (const want of fixture.expect.facts ?? []) {
    const predicateId = resolvePredicate(packId, want.predicate);
    const needle = want.objectIncludes?.toLowerCase();
    const hit = extraction.facts.some(
      (f) =>
        f.predicate === predicateId &&
        (needle === undefined || f.object.toLowerCase().includes(needle)),
    );
    if (!hit) {
      failures.push(
        `missing fact ${predicateId}${want.objectIncludes ? ` ~ "${want.objectIncludes}"` : ''}`,
      );
    }
  }
  if (
    fixture.expect.minEntities !== undefined &&
    extraction.entities.length < fixture.expect.minEntities
  ) {
    failures.push(
      `expected >= ${fixture.expect.minEntities} entities, got ${extraction.entities.length}`,
    );
  }
  if (fixture.expect.minFacts !== undefined && extraction.facts.length < fixture.expect.minFacts) {
    failures.push(`expected >= ${fixture.expect.minFacts} facts, got ${extraction.facts.length}`);
  }
  return { id: fixture.id, passed: failures.length === 0, failures };
}
