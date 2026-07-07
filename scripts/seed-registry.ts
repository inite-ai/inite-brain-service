#!/usr/bin/env ts-node
/**
 * Seed the GLOBAL Domain Pack registry with the first-party packs shipped in
 * this repo (`packs/*.json`). Idempotent — an already-published version returns
 * created:false. Run once against a fresh environment (or after adding a pack).
 *
 *   BRAIN_API_KEY=... pnpm registry:seed -- --brain-url https://brain.inite.ai
 *
 * Requires a key with the `registry:publish` scope.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { packChecksum } from '../src/ai/domain-packs/checksum';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const brainUrl = arg('brain-url') ?? process.env.BRAIN_URL;
  const key = process.env.BRAIN_API_KEY;
  if (!brainUrl || !key) {
    throw new Error('--brain-url and BRAIN_API_KEY are required');
  }
  const dir = join(__dirname, '..', 'packs');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('[seed] no packs/*.json to seed');
    return;
  }
  let created = 0;
  for (const f of files) {
    const manifest = JSON.parse(
      readFileSync(join(dir, f), 'utf8'),
    ) as DomainPackManifest;
    const checksum = packChecksum(manifest);
    const res = await fetch(`${brainUrl}/v1/admin/registry/packs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ manifest, expectedChecksum: checksum }),
    });
    if (!res.ok) {
      throw new Error(
        `[seed] ${manifest.id} v${manifest.version} failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { created?: boolean };
    if (body.created) created++;
    console.error(
      `[seed] ${manifest.id} v${manifest.version} → ${body.created ? 'published' : 'already present'}`,
    );
  }
  console.error(`[seed] done — ${created} newly published, ${files.length} total`);
}

main().catch((e) => {
  console.error(`[seed] fatal: ${(e as Error).message}`);
  process.exit(1);
});
