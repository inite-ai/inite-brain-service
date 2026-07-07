#!/usr/bin/env ts-node
/**
 * Domain Pack registry search CLI (docs/domain-packs.md) — browse the global
 * catalogue. Any key with `brain:read` may discover.
 *
 *   BRAIN_API_KEY=... pnpm pack:search -- \
 *     --brain-url https://brain.inite.ai [--q real] [--tag property] \
 *     [--publisher acme] [--versions <packId>]
 *
 * --versions <packId> lists every published version of one pack instead of the
 * catalogue summary.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function get(url: string, key: string, path: string): Promise<any> {
  const res = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  const brainUrl = arg('brain-url') ?? process.env.BRAIN_URL;
  const key = process.env.BRAIN_API_KEY;
  if (!brainUrl || !key) {
    throw new Error('--brain-url and BRAIN_API_KEY are required');
  }

  const pack = arg('versions');
  if (pack) {
    const out = await get(brainUrl, key, `/v1/registry/packs/${pack}`);
    console.error(`[registry] ${pack} — latest ${out.latestVersion ?? '(none)'}`);
    for (const v of out.versions ?? []) {
      console.log(
        `  ${v.version}${v.yanked ? ' (yanked)' : ''}  ${v.checksum.slice(0, 12)}…  ${v.signed ? 'signed' : 'unsigned'}`,
      );
    }
    return;
  }

  const params = new URLSearchParams();
  for (const k of ['q', 'tag', 'publisher', 'limit']) {
    const v = arg(k);
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  const out = await get(brainUrl, key, `/v1/registry/packs${qs ? `?${qs}` : ''}`);
  const packs = out.packs ?? [];
  console.error(`[registry] ${packs.length} pack(s)`);
  for (const p of packs) {
    console.log(
      `  ${p.packId}@${p.latestVersion}  (${p.versionCount} version(s))  ${p.description}`,
    );
  }
}

main().catch((e) => {
  console.error(`[registry] fatal: ${(e as Error).message}`);
  process.exit(1);
});
