import type { PredicateDefinition } from '../predicate-registry-internals/types';
import {
  composePredicateId,
  PACK_NAMESPACE_SEP,
  type DomainPackManifest,
} from './manifest';

/**
 * Validation + assembly for the Domain Pack standard. `validatePack` is what a
 * community author runs (also exposed via `pnpm pack:validate`); `assembleSeed`
 * is what the predicate registry runs to merge packs into the bootstrap seed,
 * failing loudly on any id collision rather than silently shadowing.
 */

const SNAKE = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export class DomainPackError extends Error {}

export function validatePack(pack: DomainPackManifest): void {
  if (!SNAKE.test(pack.id) || pack.id.includes(PACK_NAMESPACE_SEP)) {
    throw new DomainPackError(
      `pack id "${pack.id}" must be snake_case and must not contain "${PACK_NAMESPACE_SEP}"`,
    );
  }
  if (!SEMVER.test(pack.version)) {
    throw new DomainPackError(
      `pack "${pack.id}" version "${pack.version}" must be semver MAJOR.MINOR.PATCH`,
    );
  }
  if (pack.predicates.length === 0) {
    throw new DomainPackError(`pack "${pack.id}" declares no predicates`);
  }
  const seen = new Set<string>();
  for (const p of pack.predicates) {
    if (!SNAKE.test(p.localId) || p.localId.includes(PACK_NAMESPACE_SEP)) {
      throw new DomainPackError(
        `pack "${pack.id}" localId "${p.localId}" must be snake_case and must not contain "${PACK_NAMESPACE_SEP}"`,
      );
    }
    if (seen.has(p.localId)) {
      throw new DomainPackError(
        `pack "${pack.id}" declares duplicate localId "${p.localId}"`,
      );
    }
    seen.add(p.localId);
  }
}

/**
 * Merge the core seed with installed packs into one PredicateDefinition[] for
 * the registry to bootstrap. Each pack is validated; pack predicates are
 * namespaced (`<packId>__<localId>`) and stamped `createdBy:'system'`. Throws
 * on ANY id collision (pack-vs-core or pack-vs-pack) — no silent shadowing.
 */
export function assembleSeed(
  core: PredicateDefinition[],
  packs: DomainPackManifest[],
): PredicateDefinition[] {
  const byId = new Map<string, string>(); // predicateId -> origin (for errors)
  for (const c of core) byId.set(c.predicateId, 'core');

  const composed: PredicateDefinition[] = [];
  for (const pack of packs) {
    validatePack(pack);
    for (const p of pack.predicates) {
      const predicateId = composePredicateId(pack.id, p.localId);
      const prior = byId.get(predicateId);
      if (prior) {
        throw new DomainPackError(
          `predicate id collision "${predicateId}": pack "${pack.id}" vs ${prior}`,
        );
      }
      byId.set(predicateId, `pack "${pack.id}"`);
      const { localId: _localId, ...rest } = p;
      composed.push({ ...rest, predicateId, createdBy: 'system' });
    }
  }
  return [...core, ...composed];
}
