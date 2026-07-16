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
export * from './upgrade-diff';
export * from './checksum';
export * from './mcp-consent';
export * from './signature';
export * from './semver';
export * from './eval-fixture';
export * from './code-memory.pack';
// DISTRIBUTABLE industry packs (installed per-tenant at runtime), NOT builtins —
// exported for the JSON generator + tests, deliberately kept out of BUILTIN_PACKS
// so their domain predicates don't seed into every tenant. Shipped as JSON in
// packs/ and published to the registry via `pnpm registry:seed`.
export * from './real-estate.pack';
export * from './fintech.pack';
export * from './medical.pack';
export * from './legal.pack';
export * from './insurance.pack';
export * from './hr.pack';

import { REAL_ESTATE_PACK } from './real-estate.pack';
import { FINTECH_PACK } from './fintech.pack';
import { MEDICAL_PACK } from './medical.pack';
import { LEGAL_PACK } from './legal.pack';
import { INSURANCE_PACK } from './insurance.pack';
import { HR_PACK } from './hr.pack';

/** First-party distributable packs shipped in-repo (packs/*.json). The industry
 *  ontology library — distinct from BUILTIN_PACKS (globally seeded). */
export const FIRST_PARTY_PACKS: DomainPackManifest[] = [
  REAL_ESTATE_PACK,
  FINTECH_PACK,
  MEDICAL_PACK,
  LEGAL_PACK,
  INSURANCE_PACK,
  HR_PACK,
];
