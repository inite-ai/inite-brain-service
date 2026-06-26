/**
 * Pure read-path helpers extracted from EntitiesService.
 *
 * These functions carry no DB handle and no I/O — they are the
 * deterministic logic that used to live inline inside the
 * `withScopedCompany` closures (entity-id normalisation, the PII scope
 * gate, and the bitemporal "active fact" WHERE-clause builder). Pulling
 * them out makes the rules unit-testable without a live SurrealDB, and
 * removes the copy-paste of the bitemporal clause set between
 * `getProfile` and `freshnessWatermark`.
 */
import { policyFor, PREDICATE_POLICIES } from '../ingest/conflict-resolver';
import { BrainScope } from '../auth/api-key.types';

/**
 * Split a raw entity reference into the bare record id and the full
 * `table:id` form. Accepts either `knowledge_entity:foo` or bare `foo`
 * and is idempotent — passing an already-prefixed id does not double it.
 */
export function normalizeEntityId(raw: string): { id: string; full: string } {
  const id = raw.startsWith('knowledge_entity:')
    ? raw.slice('knowledge_entity:'.length)
    : raw;
  return { id, full: `knowledge_entity:${id}` };
}

/**
 * PII scope gate for a single predicate. A fact/edge whose predicate is
 * classed `requiresScope` is visible only to callers holding that scope.
 * Mirrors the DB-level PERMISSIONS fence (migration 0005) for the JS read
 * paths (profile/timeline rows, edge `kind`) where rows are materialised
 * before filtering.
 */
export function factVisibleToScopes(
  predicate: string,
  scopes: BrainScope[],
): boolean {
  const policy = policyFor(predicate);
  return !policy.requiresScope || scopes.includes(policy.requiresScope);
}

/**
 * DB-side equivalent of {@link factVisibleToScopes} for the watermark
 * probe, which never materialises rows: the set of known predicates the
 * caller may NOT see, pushed into a `predicate NOT IN $blocked` clause.
 * Derived from the same policy table so the two gates stay in lockstep —
 * a predicate is blocked here iff it is invisible there.
 */
export function blockedPredicates(scopes: BrainScope[]): string[] {
  return Object.entries(PREDICATE_POLICIES)
    .filter(([, p]) => p.requiresScope && !scopes.includes(p.requiresScope))
    .map(([predicate]) => predicate);
}

/**
 * Bitemporal "active fact" predicates for a `knowledge_fact` read.
 *
 * Without `asOf`, "active" means believed-now: `retractedAt IS NONE`.
 * With `asOf`, it is the four-axis cutoff — recorded by then, not yet
 * retracted as of then, and valid across the event-time window — so the
 * composite (entityId, status, recordedAt) index does the work instead of
 * pulling rows just to drop them in JS.
 *
 * Returns only the bitemporal clauses + their params; callers prepend the
 * `entityId = …` clause and its `$rid` param.
 */
export function activeFactWhere(asOf: Date | null): {
  clauses: string[];
  params: Record<string, unknown>;
} {
  if (asOf) {
    return {
      clauses: [
        `recordedAt <= $asOf`,
        `(retractedAt IS NONE OR retractedAt > $asOf)`,
        `validFrom <= $asOf`,
        `(validUntil IS NONE OR validUntil > $asOf)`,
      ],
      params: { asOf },
    };
  }
  return { clauses: [`retractedAt IS NONE`], params: {} };
}
