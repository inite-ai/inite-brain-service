import { CORE_PREDICATES } from '../predicate-registry-internals/core-seed';
import type { PredicateDefinition } from '../predicate-registry-internals/types';
import type { DomainPackManifest } from './manifest';
import { assembleSeed } from './validate';
import { CODE_MEMORY_PACK } from './code-memory.pack';

/**
 * The installed Domain Packs and the assembled bootstrap seed the predicate
 * registry consumes. Adding a builtin pack = author a manifest module + list it
 * here; its (namespaced) predicates are then seeded into every tenant on
 * bootstrap. Runtime per-tenant install/uninstall + distribution is the next
 * increment; this is the standard + the merge loader.
 */
export const BUILTIN_PACKS: DomainPackManifest[] = [CODE_MEMORY_PACK];

/**
 * Core predicates + every builtin pack's namespaced predicates. Validated and
 * collision-checked at module load (assembleSeed throws on a bad/ colliding
 * pack — a misconfigured pack fails the boot, not silently). The registry uses
 * this everywhere it previously used CORE_PREDICATES.
 */
export const SEED_PREDICATES: PredicateDefinition[] = assembleSeed(
  CORE_PREDICATES,
  BUILTIN_PACKS,
);

export * from './manifest';
export * from './validate';
export * from './code-memory.pack';
