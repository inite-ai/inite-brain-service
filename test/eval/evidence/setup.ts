/**
 * Phase 0 (gates) and phase 1 (fixtures) of the evidence battery, plus
 * the single irreversible phase 3 act (GDPR erasure).
 *
 * PHASE 0 reads the stand instead of assuming it: every EVIDENCE_* knob
 * comes from GET /v1/admin/config, the orphan-GC maintenance route is
 * PROBED rather than presumed, and the fixture packs are installed and
 * their failure recorded. Those observations become the skip reasons of
 * every dependent check, which is what keeps a missing capability from
 * reading as a pass.
 *
 * PHASE 1 mints four assets in tenant A and (optionally) one in tenant B.
 * They are separate on purpose: the grant-revocation check administratively
 * KILLS its asset and the erasure phase destroys another, so sharing one
 * fixture between them would make later checks measure earlier checks'
 * damage instead of the platform.
 */
import type { Ctx } from './context';
import { denyPackManifest, probePackManifest, uploadFields } from './fixtures';
import type { Gates, MintedAsset } from './types';
import type { JsonResult, Wire } from './wire';
import { arr, bool, call, num, sha256, str, upload } from './wire';

/** Env names whose live value the gates keep (everything else is noise). */
const GATE_PREFIXES = ['EVIDENCE_', 'RETRIEVAL_FRAGMENT_LANE', 'FOVEA_FRAGMENT_ZOOM'];

interface ConfigEntry {
  key?: unknown;
  currentValue?: unknown;
  secret?: unknown;
}

/** GET /v1/admin/config → the live knob map plus the masked-secret set. */
async function readConfig(
  wire: Wire,
): Promise<{ config: Map<string, string>; secretKeys: Set<string> }> {
  const config = new Map<string, string>();
  const secretKeys = new Set<string>();
  const res = await call(wire, { method: 'GET', path: '/v1/admin/config' });
  for (const raw of arr(res.json, 'entries')) {
    const entry = raw as ConfigEntry;
    if (typeof entry.key !== 'string') continue;
    if (!GATE_PREFIXES.some((p) => entry.key === p || String(entry.key).startsWith(p))) continue;
    config.set(entry.key, typeof entry.currentValue === 'string' ? entry.currentValue : '');
    if (entry.secret === true) secretKeys.add(entry.key);
  }
  return { config, secretKeys };
}

/** Install one fixture pack; returns its id, or null with the reason. */
async function installPack(
  wire: Wire,
  manifest: Record<string, unknown>,
): Promise<{ packId: string | null; error: string | null }> {
  const res = await call(wire, {
    method: 'POST',
    path: '/v1/admin/packs',
    body: { manifest, acceptModalities: true },
  });
  if (res.status === 200 || res.status === 201) {
    return { packId: String(manifest.id), error: null };
  }
  return { packId: null, error: `HTTP ${res.status} — ${res.text}` };
}

export async function buildGates(ctx: {
  wire: Wire;
  wireB: Wire | null;
  runId: string;
}): Promise<Gates> {
  const { config, secretKeys } = await readConfig(ctx.wire);
  const probe = await call(ctx.wire, {
    method: 'POST',
    path: '/v1/admin/maintenance/evidence/orphan-blob-gc',
    body: { dryRun: true },
  });
  const installed = await installPack(ctx.wire, probePackManifest(ctx.runId));
  const deny = await installPack(ctx.wire, denyPackManifest(ctx.runId));
  return {
    config,
    secretKeys,
    orphanGcRoute: { present: probe.status !== 404, status: probe.status },
    packId: installed.packId,
    packError: installed.error,
    denyPackId: deny.packId,
    tenantB: ctx.wireB ? { companyId: ctx.wireB.companyId, apiKey: ctx.wireB.apiKey } : null,
  };
}

/** Turn one upload response into a MintedAsset, or null when it failed. */
function assetOf(res: JsonResult, data: Buffer): MintedAsset | null {
  const assetId = str(res.json, 'assetId');
  if (assetId === null) return null;
  return {
    assetId,
    byteHash: str(res.json, 'byteHash') ?? sha256(data),
    bytes: data,
    storageRef: str(res.json, 'storageRef') ?? '',
    availability: str(res.json, 'availability') ?? '',
    deduped: bool(res.json, 'deduped') ?? false,
    fragmentId: null,
  };
}

/** Upload one document blob as a named owner. */
export async function mintAsset(
  wire: Wire,
  data: Buffer,
  owner: { userId: string; runId: string },
): Promise<{ asset: MintedAsset | null; res: JsonResult }> {
  const res = await upload(
    wire,
    { data, filename: `${owner.runId}.txt`, contentType: 'text/plain' },
    uploadFields({ userId: owner.userId, runId: owner.runId }),
  );
  return { asset: assetOf(res, data), res };
}

/**
 * Attach a citation target to an already-stored blob through the dedup
 * path: the metadata surface takes no bytes, so re-registering the SAME
 * byteHash as the SAME owner returns the existing blob-backed row and
 * appends the fragments to it. This is the only route by which a
 * caller-asserted fragment ends up over real bytes.
 */
export async function appendFragment(
  wire: Wire,
  asset: MintedAsset,
  owner: { userId: string; runId: string },
): Promise<string | null> {
  const res = await call(wire, {
    method: 'POST',
    path: '/v1/ingest/evidence-asset',
    body: {
      modality: 'document',
      mediaType: 'text/plain',
      byteHash: asset.byteHash,
      byteLength: asset.bytes.byteLength,
      occurredAt: new Date().toISOString(),
      originUri: `https://example.invalid/${owner.runId}/${asset.byteHash.slice(0, 12)}`,
      vertical: 'evidence_eval',
      userId: owner.userId,
      piiClasses: [],
      recorder: `evidence-battery-${owner.runId}`,
      fragments: [
        {
          locator: { kind: 'charRange', start: 0, end: 32 },
          label: 'battery anchor',
          piiClasses: [],
          excerpt: asset.bytes.subarray(0, 32).toString('utf8'),
          lang: 'en',
        },
      ],
    },
  });
  const first = arr(res.json, 'fragments')[0];
  return first === undefined ? null : str(first, 'fragmentId');
}

/** Mint a signed URL token over an asset; null when the mint refused. */
export async function mintToken(
  wire: Wire,
  assetId: string,
): Promise<{ token: string; expiresAt: number } | null> {
  const res = await call(wire, { method: 'GET', path: `/v1/evidence/${assetId}/raw-url` });
  const token = str(res.json, 'token');
  const expiresAt = str(res.json, 'expiresAt');
  if (token === null) return null;
  const at = expiresAt === null ? Date.now() : new Date(expiresAt).getTime();
  return { token, expiresAt: Number.isNaN(at) ? Date.now() : at };
}

/** Share an asset with one more owner (the co-ownership fixture). */
export async function shareWith(wire: Wire, assetId: string, ownerId: string): Promise<number> {
  const res = await call(wire, {
    method: 'POST',
    path: `/v1/evidence/${assetId}/grants`,
    body: { ownerKind: 'user', ownerId, purpose: 'share' },
  });
  return res.status;
}

/** Phase 3: the one irreversible act, run between the two check groups. */
export async function runForget(ctx: Ctx): Promise<{ status: number; json: unknown }> {
  const res = await call(ctx.wire, {
    method: 'POST',
    path: `/v1/users/${encodeURIComponent(ctx.forgetUserId)}/forget`,
  });
  return { status: res.status, json: res.json };
}

/** Human-readable trail of what phase 0/1 observed, for the report file. */
export function setupTrail(ctx: Ctx): Record<string, string> {
  const g = ctx.gates;
  const knobs = [...g.config.entries()]
    .filter(([k]) => k.startsWith('EVIDENCE_') && !k.includes('SECRET') && !k.includes('FS_ROOT'))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return {
    knobs,
    probePack: g.packId ?? `NOT INSTALLED (${g.packError ?? 'unknown'})`,
    denyPack: g.denyPackId ?? 'NOT INSTALLED',
    orphanGcRoute: g.orphanGcRoute.present ? 'present' : `absent (HTTP ${g.orphanGcRoute.status})`,
    tenantB: g.tenantB ? g.tenantB.companyId : 'not configured',
    assets: [
      `primary=${ctx.stand.primary?.assetId ?? 'none'}`,
      `spare=${ctx.stand.spare?.assetId ?? 'none'}`,
      `sole=${ctx.stand.sole?.assetId ?? 'none'}`,
      `shared=${ctx.stand.shared?.assetId ?? 'none'}`,
      `tenantB=${ctx.stand.tenantB?.assetId ?? 'none'}`,
    ].join(' '),
    dispatchCounters: ctx.stand.firstDispatch
      ? Object.entries(ctx.stand.firstDispatch)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : 'not dispatched',
    forget: ctx.stand.forget
      ? `HTTP ${ctx.stand.forget.status} assets=${num(ctx.stand.forget.json, 'evidenceAssetsDeleted') ?? '?'}`
      : 'not run',
  };
}
