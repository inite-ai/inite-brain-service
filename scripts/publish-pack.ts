#!/usr/bin/env ts-node
/**
 * Domain Pack publish CLI (docs/domain-packs.md) — publish a pack manifest into
 * the GLOBAL registry so other tenants can discover + install it.
 *
 *   BRAIN_API_KEY=... pnpm pack:publish -- \
 *     --brain-url https://brain.inite.ai --file ./my-pack.json \
 *     [--keywords real-estate,property] [--verify]
 *
 * Requires a key with the `registry:publish` scope. A published (packId,
 * version) is IMMUTABLE — republishing the same version with different content
 * is rejected (409); an identical republish is idempotent. --verify pins the
 * locally-computed checksum in the request.
 */
import { readFileSync } from 'node:fs';
import { packChecksum } from '../src/ai/domain-packs/checksum';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const brainUrl = arg('brain-url') ?? process.env.BRAIN_URL;
  const file = arg('file');
  const key = process.env.BRAIN_API_KEY;
  if (!brainUrl || !file || !key) {
    throw new Error('--brain-url, --file and BRAIN_API_KEY are required');
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as DomainPackManifest;
  const checksum = packChecksum(manifest);
  const keywords = (arg('keywords') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  console.error(
    `[pack] publishing ${manifest.id} v${manifest.version} checksum=${checksum}`,
  );

  const res = await fetch(`${brainUrl}/v1/admin/registry/packs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      manifest,
      ...(keywords.length ? { keywords } : {}),
      ...(process.argv.includes('--verify') ? { expectedChecksum: checksum } : {}),
    }),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  console.error(`[pack] published: ${JSON.stringify(await res.json())}`);
}

main().catch((e) => {
  console.error(`[pack] fatal: ${(e as Error).message}`);
  process.exit(1);
});
