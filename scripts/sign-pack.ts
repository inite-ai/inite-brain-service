#!/usr/bin/env ts-node
/**
 * Domain Pack signing CLI (docs/domain-packs.md).
 *
 *   pnpm pack:sign -- --file pack.json --key priv.pem --publisher acme [--out signed.json]
 *
 * Writes an ed25519 `signature` (+ `publisher`) into the manifest so a tenant
 * whose trust store holds acme's public key can verify authorship on install.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { signPack } from '../src/ai/domain-packs/signature';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const file = arg('file');
  const keyFile = arg('key');
  const publisher = arg('publisher');
  if (!file || !keyFile || !publisher) {
    throw new Error('--file, --key and --publisher are required');
  }
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as DomainPackManifest;
  manifest.publisher = publisher;
  delete manifest.signature;
  manifest.signature = signPack(manifest, readFileSync(keyFile, 'utf8'));
  const out = arg('out') ?? file;
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`[pack] signed ${manifest.id} as "${publisher}" → ${out}`);
}

try {
  main();
} catch (e) {
  console.error(`[pack] sign failed: ${(e as Error).message}`);
  process.exit(1);
}
