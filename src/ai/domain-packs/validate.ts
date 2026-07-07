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
  if (pack.extractionProfile !== undefined) {
    validateExtractionProfile(pack.id, pack.extractionProfile);
  }
  if (pack.evalFixtures !== undefined) {
    validateEvalFixtures(pack.id, pack.evalFixtures);
  }
}

/** Validate a pack's eval fixtures (consumed by the eval runner, so a malformed
 *  one is a boot/install-time error). Structural only. */
function validateEvalFixtures(packId: string, fixtures: unknown): void {
  if (!Array.isArray(fixtures)) {
    throw new DomainPackError(`pack "${packId}" evalFixtures must be an array`);
  }
  const ids = new Set<string>();
  for (const f of fixtures) {
    const fx = f as { id?: unknown; text?: unknown; expect?: unknown };
    if (typeof fx.id !== 'string' || !fx.id) {
      throw new DomainPackError(
        `pack "${packId}" evalFixtures entries need a non-empty string id`,
      );
    }
    if (ids.has(fx.id)) {
      throw new DomainPackError(
        `pack "${packId}" evalFixtures has duplicate id "${fx.id}"`,
      );
    }
    ids.add(fx.id);
    if (typeof fx.text !== 'string' || !fx.text) {
      throw new DomainPackError(
        `pack "${packId}" evalFixture "${fx.id}" needs a non-empty text`,
      );
    }
    if (
      typeof fx.expect !== 'object' ||
      fx.expect === null ||
      Array.isArray(fx.expect)
    ) {
      throw new DomainPackError(
        `pack "${packId}" evalFixture "${fx.id}" needs an expect object`,
      );
    }
    const facts = (fx.expect as { facts?: unknown }).facts;
    if (facts !== undefined) {
      if (!Array.isArray(facts)) {
        throw new DomainPackError(
          `pack "${packId}" evalFixture "${fx.id}" expect.facts must be an array`,
        );
      }
      for (const want of facts) {
        if (
          typeof (want as { predicate?: unknown })?.predicate !== 'string'
        ) {
          throw new DomainPackError(
            `pack "${packId}" evalFixture "${fx.id}" expect.facts entries need a string predicate`,
          );
        }
      }
    }
  }
}

/**
 * Validate a pack's extraction profile shape (it's consumed into the extractor
 * prompt, so a malformed one is a boot/install-time error, not silent). Kept
 * permissive — only structural shape is enforced.
 */
function validateExtractionProfile(packId: string, profile: unknown): void {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new DomainPackError(
      `pack "${packId}" extractionProfile must be an object`,
    );
  }
  const { guidance, fewShot } = profile as {
    guidance?: unknown;
    fewShot?: unknown;
  };
  if (guidance !== undefined && typeof guidance !== 'string') {
    throw new DomainPackError(
      `pack "${packId}" extractionProfile.guidance must be a string`,
    );
  }
  if (fewShot !== undefined) {
    if (!Array.isArray(fewShot)) {
      throw new DomainPackError(
        `pack "${packId}" extractionProfile.fewShot must be an array`,
      );
    }
    for (const ex of fewShot) {
      if (
        typeof ex !== 'object' ||
        ex === null ||
        typeof (ex as { text?: unknown }).text !== 'string' ||
        typeof (ex as { note?: unknown }).note !== 'string'
      ) {
        throw new DomainPackError(
          `pack "${packId}" extractionProfile.fewShot entries must be { text: string, note: string }`,
        );
      }
    }
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
