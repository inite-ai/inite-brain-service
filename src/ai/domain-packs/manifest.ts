import type { PredicateDefinition } from '../predicate-registry-internals/types';

/**
 * Domain Pack standard (docs/domain-packs.md).
 *
 * A DomainPack is a versioned, pluggable bundle of ontology that extends the
 * brain predicate registry without forking core. The community authors packs;
 * brain merges their predicates (namespaced) into every tenant's registry on
 * bootstrap. This file is the manifest CONTRACT — the schema third parties
 * conform to.
 *
 * Namespacing: every pack predicate is stored as `<packId>__<localId>` (double
 * underscore = the reserved separator). This keeps ids inside the existing
 * `^[a-z][a-z0-9_]*$` predicate-id charset (so admin CRUD + routing keep
 * working) and guarantees community packs can't collide with core or each
 * other. Core predicates are the reserved UNPREFIXED namespace and are never
 * renamed (that would orphan existing facts).
 */

/** Reserved namespace separator between packId and a predicate's localId. */
export const PACK_NAMESPACE_SEP = '__';

/** A predicate as declared INSIDE a pack — a core PredicateDefinition minus the
 *  fully-qualified id (the loader composes it) and the provenance tag (the
 *  loader stamps it). The pack author supplies a `localId` instead. */
export type PackPredicate = Omit<
  PredicateDefinition,
  'predicateId' | 'createdBy'
> & { localId: string };

/** The versioned, self-describing pack manifest — the community standard. */
export interface DomainPackManifest {
  /** snake_case pack id, no `__`. The predicate namespace. */
  id: string;
  /** semver MAJOR.MINOR.PATCH. Bump to ship an updated ontology. */
  version: string;
  /** One-line human description. */
  description: string;
  /** The ontology this pack contributes. */
  predicates: PackPredicate[];
}

/** Compose the stored, namespaced predicate id for a pack-local predicate. */
export function composePredicateId(packId: string, localId: string): string {
  return `${packId}${PACK_NAMESPACE_SEP}${localId}`;
}
