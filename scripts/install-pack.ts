#!/usr/bin/env ts-node
/**
 * Domain Pack install CLI (docs/domain-packs.md) — install a distributed pack
 * from a JSON manifest file into a tenant.
 *
 *   BRAIN_API_KEY=... pnpm pack:install -- \
 *     --brain-url https://brain.inite.ai --file ./my-pack.json [--verify]
 *
 * --verify recomputes the manifest checksum locally and pins it in the request,
 * so the server rejects if what it receives differs from what you reviewed.
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
  console.error(`[pack] ${manifest.id} v${manifest.version} checksum=${checksum}`);

  const res = await fetch(`${brainUrl}/v1/admin/packs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      manifest,
      ...(process.argv.includes('--verify') ? { expectedChecksum: checksum } : {}),
    }),
  });
  if (!res.ok) throw new Error(`install failed: ${res.status} ${await res.text()}`);
  console.error(`[pack] installed: ${JSON.stringify(await res.json())}`);
}

main().catch((e) => {
  console.error(`[pack] fatal: ${(e as Error).message}`);
  process.exit(1);
});
