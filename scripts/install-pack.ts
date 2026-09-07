#!/usr/bin/env ts-node
/**
 * Domain Pack install CLI (docs/domain-packs.md) — install a pack into a tenant,
 * either from a local JSON manifest OR from the global registry.
 *
 *   # from a local manifest file (integrity-pinned with --verify)
 *   BRAIN_API_KEY=... pnpm pack:install -- \
 *     --brain-url https://brain.inite.ai --file ./my-pack.json [--verify]
 *
 *   # from the registry (latest non-yanked, or a pinned version)
 *   BRAIN_API_KEY=... pnpm pack:install -- \
 *     --brain-url https://brain.inite.ai --registry real_estate[@0.3.0]
 *
 * --verify (file mode) recomputes the manifest checksum locally and pins it in
 * the request, so the server rejects if what it receives differs from what you
 * reviewed. Registry installs are always checksum-pinned server-side.
 *
 * --accept-modalities is the OPERATOR CONSENT flag for a manifest whose
 * memoryModel declares non-text modalities, non-text processor needs, or the
 * raw-evidence capability (every first-party pack does, as of the 0.3.0
 * line). Without it the server refuses the install with a 400 naming what
 * would be accepted. Read the manifest's media section first — that is the
 * point of the flag.
 */
import { readFileSync } from 'node:fs';
import { packChecksum } from '../src/ai/domain-packs/checksum';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function post(
  url: string,
  key: string,
  path: string,
  body: unknown,
): Promise<void> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`install failed: ${res.status} ${await res.text()}`);
  console.error(`[pack] installed: ${JSON.stringify(await res.json())}`);
}

async function main(): Promise<void> {
  const brainUrl = arg('brain-url') ?? process.env.BRAIN_URL;
  const key = process.env.BRAIN_API_KEY;
  const file = arg('file');
  const registry = arg('registry');
  if (!brainUrl || !key || (!file && !registry)) {
    throw new Error(
      '--brain-url, BRAIN_API_KEY and one of --file / --registry are required',
    );
  }

  // Operator consent to the manifest's media section (see the header).
  const consent = process.argv.includes('--accept-modalities')
    ? { acceptModalities: true }
    : {};

  if (registry) {
    // <packId> or <packId>@<version>
    const [packId, version] = registry.split('@');
    console.error(
      `[pack] installing ${packId}${version ? `@${version}` : ' (latest)'} from registry`,
    );
    await post(brainUrl, key, '/v1/admin/packs/from-registry', {
      packId,
      ...(version ? { version } : {}),
      ...consent,
    });
    return;
  }

  const manifest = JSON.parse(readFileSync(file!, 'utf8')) as DomainPackManifest;
  const checksum = packChecksum(manifest);
  console.error(`[pack] ${manifest.id} v${manifest.version} checksum=${checksum}`);
  await post(brainUrl, key, '/v1/admin/packs', {
    manifest,
    ...(process.argv.includes('--verify') ? { expectedChecksum: checksum } : {}),
    ...consent,
  });
}

main().catch((e) => {
  console.error(`[pack] fatal: ${(e as Error).message}`);
  process.exit(1);
});
