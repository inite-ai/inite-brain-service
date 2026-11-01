import { CORE_PREDICATES } from './predicate-registry-internals/core-seed';

/**
 * Predicates whose slot holds one value at a time. The tenant's registry
 * rows decide; a core predicate the registry has not seeded into this
 * tenant yet (it seeds on first read) answers from the code seed.
 */
export function singleValuedPredicates(
  rows: ReadonlyArray<{ predicateId: string; semantics: string }>,
): Set<string> {
  const semantics = new Map(CORE_PREDICATES.map((p) => [p.predicateId, p.semantics as string]));
  for (const r of rows) semantics.set(r.predicateId, r.semantics);
  return new Set([...semantics].filter(([, s]) => s !== 'append_only').map(([id]) => id));
}
