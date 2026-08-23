import type { PredicateDefinition } from '../predicate-registry-internals/types';
import { composePredicateId, type DomainPackManifest, type PackPredicate } from './manifest';

/**
 * Upgrade diff for the runtime pack-install path. `seedMissingPredicates` only
 * CREATEs ids that don't yet exist, so on a version bump it does nothing for a
 * predicate that already exists — even if the new manifest redefined it, or
 * dropped it. Without applying the diff a tenant's ontology stays frozen at the
 * first-install values (wrong piiClass/semantics/description survive) and
 * dropped predicates linger active. This computes what an upgrade must apply:
 * the redefined predicates to re-write, and the ids to deprecate. Additions are
 * left to seedMissingPredicates. Pure — unit-tested; the service does the I/O.
 */

/** Behaviour-defining fields of a pack predicate. A change in any of these is a
 *  meaningful redefinition to re-apply (localId is structural, not behaviour). */
const DEFINITION_FIELDS: Array<keyof PackPredicate> = [
  'displayLabel',
  'description',
  'datatype',
  'semantics',
  'decayHalfLifeDays',
  'piiClass',
  'requiresScope',
  'parentPredicateId',
  'subjectClasses',
  'allowedValues',
];

export interface PackUpgradeDiff {
  /** Predicates present in both manifests whose definition changed — re-apply. */
  changed: PredicateDefinition[];
  /** Namespaced ids present in the prior manifest but gone in the new — deprecate. */
  removedIds: string[];
}

function defsDiffer(a: PackPredicate, b: PackPredicate): boolean {
  for (const f of DEFINITION_FIELDS) {
    // JSON compare handles scalars, arrays, and undefined-vs-absent uniformly.
    if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) {
      return true;
    }
  }
  return false;
}

export function diffPackUpgrade(
  packId: string,
  prior: DomainPackManifest | undefined,
  next: DomainPackManifest,
): PackUpgradeDiff {
  const priorByLocal = new Map((prior?.predicates ?? []).map((p) => [p.localId, p]));
  const nextByLocal = new Map((next.predicates ?? []).map((p) => [p.localId, p]));

  const changed: PredicateDefinition[] = [];
  for (const [localId, np] of nextByLocal) {
    const pp = priorByLocal.get(localId);
    if (pp && defsDiffer(pp, np)) {
      const { localId: _localId, ...rest } = np;
      changed.push({
        ...rest,
        predicateId: composePredicateId(packId, localId),
        createdBy: 'admin',
      });
    }
  }

  const removedIds: string[] = [];
  for (const localId of priorByLocal.keys()) {
    if (!nextByLocal.has(localId)) {
      removedIds.push(composePredicateId(packId, localId));
    }
  }

  return { changed, removedIds };
}
