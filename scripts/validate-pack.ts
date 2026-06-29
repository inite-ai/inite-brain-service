#!/usr/bin/env ts-node
/**
 * Domain Pack validator CLI (docs/domain-packs.md).
 *
 *   pnpm pack:validate path/to/pack.json
 *
 * Validates a Domain Pack manifest (JSON) against the standard — snake_case +
 * non-colliding namespaced ids, semver, non-empty predicate set. Community pack
 * authors run this before publishing. Exit 0 = valid, 1 = invalid.
 */
import { readFileSync } from 'node:fs';
import { assembleSeed, validatePack } from '../src/ai/domain-packs/validate';
import { CORE_PREDICATES } from '../src/ai/predicate-registry-internals/core-seed';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

function main(): void {
  const path = process.argv[2];
  if (!path) throw new Error('usage: pack:validate <path/to/pack.json>');

  const manifest = JSON.parse(readFileSync(path, 'utf8')) as DomainPackManifest;
  validatePack(manifest);
  // Also assemble against core to surface any id collision with core predicates.
  assembleSeed(CORE_PREDICATES, [manifest]);

  console.log(
    `✓ pack "${manifest.id}" v${manifest.version} valid — ${manifest.predicates.length} predicate(s), namespaced ${manifest.id}__*`,
  );
}

try {
  main();
} catch (e) {
  console.error(`✗ invalid pack: ${(e as Error).message}`);
  process.exit(1);
}
