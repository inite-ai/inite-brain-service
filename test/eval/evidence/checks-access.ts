/**
 * E5–E8: the read half — whether a stored observation can be unrolled
 * back to its exact bytes by the people entitled to it, and only by them,
 * and whether it disappears when it must.
 *
 * The north-star property lives here: a citation target (an
 * `evidence_fragment`) must resolve to the EXACT blob it points at, both
 * through the authenticated gateway and through a signed URL. Everything
 * else on this side is a fence around that: grants, tenant pinning,
 * expiry, GC and GDPR erasure.
 *
 * Same gap-gating rule as the write half — a check whose precondition the
 * stand cannot produce reports `skipped` with the reason it observed.
 */
import type { Ctx } from './context';
import { Findings, knob, knobOn } from './context';
import type { MintedAsset, Verdict } from './types';
import { fail, pass, skip } from './types';
import { arr, bytes, call, num, sha256, sleep, str } from './wire';

/** A record id shaped like the real thing but that no writer can mint. */
const ABSENT_FRAGMENT = 'evidence_fragment:evevbatterynosuchfragment000';

/** Slack allowed between a minted `expiresAt` and the configured TTL. */
const TTL_SLACK_MS = 15_000;

/** Guard against a stand that never expires the token we are waiting on. */
const EXPIRY_POLL_MS = 2_000;

const rawPath = (asset: MintedAsset): string => `/v1/evidence/${asset.assetId}/raw`;
const fragmentRawPath = (fragmentId: string): string => `/v1/evidence/fragments/${fragmentId}/raw`;

// ── E5 · citations ──────────────────────────────────────────────────

export async function e17FragmentUnrolls(ctx: Ctx): Promise<Verdict> {
  const asset = ctx.stand.primary;
  if (!knobOn(ctx, 'EVIDENCE_RAW_READ_ENABLED')) return skip('EVIDENCE_RAW_READ_ENABLED is off');
  if (!asset?.fragmentId) return skip('no fragment was created on the primary asset');
  const res = await bytes(ctx.wire, { path: fragmentRawPath(asset.fragmentId) });
  if (res.status !== 200) {
    return fail(
      `the fragment raw read answered HTTP ${res.status} (a uniform 404 covers every ladder ` +
        `deny: tenant, availability, grant, consent, media PII, blob head)`,
    );
  }
  const f = new Findings();
  f.ok(
    sha256(res.body) === asset.byteHash,
    'the citation target unrolled to exactly the registered blob',
    `served bytes hash ${sha256(res.body)} != the asset identity ${asset.byteHash}`,
  );
  f.ok(
    res.headers.get('x-content-type-options') === 'nosniff',
    'nosniff set',
    `x-content-type-options='${String(res.headers.get('x-content-type-options'))}'`,
  );
  f.ok(
    (res.headers.get('cache-control') ?? '').includes('no-store'),
    'no-store set',
    `cache-control='${String(res.headers.get('cache-control'))}'`,
  );
  f.ok(
    (res.headers.get('content-disposition') ?? '').includes('attachment'),
    'attachment disposition set',
    `content-disposition='${String(res.headers.get('content-disposition'))}'`,
  );
  return f.verdict();
}

export async function e18SignedUnroll(ctx: Ctx): Promise<Verdict> {
  const asset = ctx.stand.primary;
  if (!knobOn(ctx, 'EVIDENCE_RAW_READ_ENABLED')) return skip('EVIDENCE_RAW_READ_ENABLED is off');
  if (!asset?.fragmentId) return skip('no fragment was created on the primary asset');
  const mint = await call(ctx.wire, {
    method: 'GET',
    path: `/v1/evidence/fragments/${asset.fragmentId}/raw-url`,
  });
  if (mint.status === 503) return skip(`mint refused 503 — ${mint.text}`);
  if (mint.status !== 200) return fail(`raw-url mint answered HTTP ${mint.status} — ${mint.text}`);
  const url = str(mint.json, 'url');
  if (url === null) return fail(`mint returned no url — ${mint.text}`);
  const redeemed = await bytes(ctx.wire, { path: url, auth: false });
  if (redeemed.status !== 200) {
    return fail(`the unauthenticated redeem answered HTTP ${redeemed.status}`);
  }
  return sha256(redeemed.body) === asset.byteHash
    ? pass('the signed URL unrolled the citation to the same blob as the authenticated read')
    : fail(`redeemed bytes hash ${sha256(redeemed.body)} != ${asset.byteHash}`);
}

export async function e19CitationTargetFence(ctx: Ctx): Promise<Verdict> {
  const spare = ctx.stand.spare;
  const primary = ctx.stand.primary;
  if (!knobOn(ctx, 'EVIDENCE_RAW_READ_ENABLED')) return skip('EVIDENCE_RAW_READ_ENABLED is off');
  if (!primary?.fragmentId || !spare?.fragmentId) {
    return skip('the two-asset fixture (primary + spare, each with a fragment) is incomplete');
  }
  const unknown = await bytes(ctx.wire, { path: fragmentRawPath(ABSENT_FRAGMENT) });
  const spareRead = await bytes(ctx.wire, { path: fragmentRawPath(spare.fragmentId) });
  const f = new Findings();
  f.ok(
    unknown.status === 404,
    'an unknown fragment id answers a bare 404',
    `unknown id answered HTTP ${unknown.status}`,
  );
  f.ok(
    spareRead.status === 200 && sha256(spareRead.body) === spare.byteHash,
    "a second asset's fragment unrolls to ITS bytes, not the primary's",
    `the spare fragment answered HTTP ${spareRead.status} with hash ${sha256(spareRead.body)} ` +
      `(want ${spare.byteHash}, must not be ${primary.byteHash})`,
  );
  f.ok(
    spare.byteHash !== primary.byteHash,
    'the two fixtures are distinguishable by content',
    'the fixture payloads collided — the fence cannot be measured',
  );
  return f.verdict();
}

// ── E6 · access ─────────────────────────────────────────────────────

export async function e20SignedUrlExpiry(ctx: Ctx): Promise<Verdict> {
  const token = ctx.stand.agingToken;
  if (!knobOn(ctx, 'EVIDENCE_RAW_READ_ENABLED')) return skip('EVIDENCE_RAW_READ_ENABLED is off');
  if (token === null) return skip('no token was minted in the setup phase');
  const ttl = Number(knob(ctx, 'EVIDENCE_SIGNED_URL_TTL_SECONDS') || '300');
  const mintedFor = ctx.stand.agingTokenExpiresAt - Date.now();
  if (mintedFor > ttl * 1000 + TTL_SLACK_MS) {
    return fail(
      `expiresAt is ${Math.round(mintedFor / 1000)}s away but EVIDENCE_SIGNED_URL_TTL_SECONDS ` +
        `is ${ttl} — the mint outlives its configured lifetime`,
    );
  }
  if (ttl > ctx.maxWaitSeconds) {
    return skip(
      `EVIDENCE_SIGNED_URL_TTL_SECONDS is ${ttl}s, above the battery's ${ctx.maxWaitSeconds}s wait ` +
        'ceiling (EVEV_MAX_WAIT_S) — the expiry half was not measured',
    );
  }
  while (Date.now() < ctx.stand.agingTokenExpiresAt + EXPIRY_POLL_MS) {
    await sleep(EXPIRY_POLL_MS);
  }
  const res = await bytes(ctx.wire, { path: `/v1/evidence/redeem/${token}`, auth: false });
  return res.status === 404
    ? pass(`a token past its ${ttl}s lifetime redeems to a bare 404`)
    : fail(`an expired token still answered HTTP ${res.status} — the TTL is not enforced`);
}

export async function e21CrossTenantRefusal(ctx: Ctx): Promise<Verdict> {
  const asset = ctx.stand.primary;
  if (ctx.wireB === null) {
    return skip('no second tenant configured — set EVEV_TENANT_B_ID and EVEV_TENANT_B_KEY');
  }
  if (!asset) return skip('no primary asset — the first upload failed');
  const stream = await bytes(ctx.wireB, { path: rawPath(asset) });
  const mint = await call(ctx.wireB, {
    method: 'GET',
    path: `/v1/evidence/${asset.assetId}/raw-url`,
  });
  const f = new Findings();
  f.ok(
    stream.status === 404,
    "tenant B cannot stream tenant A's asset",
    `tenant B streaming A's asset answered HTTP ${stream.status}`,
  );
  f.ok(
    mint.status === 404,
    "tenant B cannot mint a signed URL over tenant A's asset",
    `tenant B minting over A's asset answered HTTP ${mint.status} — ${mint.text}`,
  );
  return f.verdict();
}

export async function e22GrantRevocationBackstop(ctx: Ctx): Promise<Verdict> {
  const spare = ctx.stand.spare;
  const token = ctx.stand.spareToken;
  if (!knobOn(ctx, 'EVIDENCE_GRANTS_API_ENABLED'))
    return skip('EVIDENCE_GRANTS_API_ENABLED is off');
  if (!spare) return skip('the spare asset was not created');
  const listed = await call(ctx.wire, {
    method: 'GET',
    path: `/v1/evidence/${spare.assetId}/grants`,
  });
  if (listed.status !== 200)
    return fail(`grant list answered HTTP ${listed.status} — ${listed.text}`);
  const grants = arr(listed.json, 'grants');
  if (grants.length === 0)
    return fail('a freshly registered asset carries no live ownership grant');
  const before = await bytes(ctx.wire, { path: rawPath(spare) });
  for (const grant of grants) {
    const id = str(grant, 'grantId');
    if (id === null) continue;
    await call(ctx.wire, { method: 'DELETE', path: `/v1/evidence/grants/${id}` });
  }
  const after = await bytes(ctx.wire, { path: rawPath(spare) });
  const f = new Findings();
  f.ok(
    before.status === 200,
    `${grants.length} live grant(s) served the bytes`,
    `the owned asset answered HTTP ${before.status} before revocation`,
  );
  f.ok(
    after.status === 404,
    'revoking every grant closed the authenticated read',
    `the read still answered HTTP ${after.status} after every grant was revoked`,
  );
  if (token !== null) {
    const redeemed = await bytes(ctx.wire, { path: `/v1/evidence/redeem/${token}`, auth: false });
    f.ok(
      redeemed.status === 404,
      'a URL minted before revocation stopped redeeming — the live-grant backstop holds',
      `a token minted before revocation still answered HTTP ${redeemed.status}`,
    );
  }
  return f.verdict();
}

export function e23SigningSecretNotReadable(ctx: Ctx): Verdict {
  const value = ctx.gates.config.get('EVIDENCE_SIGNED_URL_SECRET');
  const masked = ctx.gates.secretKeys.has('EVIDENCE_SIGNED_URL_SECRET');
  if (value === undefined) {
    return pass('GET /v1/admin/config does not surface the signed-URL secret at all');
  }
  if (masked || value === '' || value === '∅' || value === '••• set') {
    return pass(`the config viewer masks the signed-URL secret (reads '${value}')`);
  }
  return fail(
    'GET /v1/admin/config returns EVIDENCE_SIGNED_URL_SECRET VERBATIM — the catalog entry ' +
      '(src/admin/config-catalog.data.ts) omits `secret: true`, unlike OPENAI_API_KEY. Any ' +
      'brain:admin key can read the HMAC key that signs raw-evidence URLs and forge tokens ' +
      `over any asset in reach (observed ${value.length} plaintext characters).`,
  );
}

// ── E7 · garbage collection ─────────────────────────────────────────

export async function e24OrphanGcSurface(ctx: Ctx): Promise<Verdict> {
  if (!ctx.gates.orphanGcRoute.present) {
    return skip(
      'POST /v1/admin/maintenance/evidence/orphan-blob-gc answers ' +
        `HTTP ${ctx.gates.orphanGcRoute.status} — the orphan-blob GC sweep is not in this build ` +
        '(it lands with PR #481), so an unreferenced blob is never collected here',
    );
  }
  const asset = ctx.stand.primary;
  if (!asset) return skip('no primary asset — the first upload failed');
  const res = await call(ctx.wire, {
    method: 'POST',
    path: '/v1/admin/maintenance/evidence/orphan-blob-gc',
    body: { dryRun: true },
  });
  if (res.status !== 200 && res.status !== 201) {
    return fail(`the orphan sweep answered HTTP ${res.status} — ${res.text}`);
  }
  const deleted = num(res.json, 'deleted') ?? 0;
  return res.text.includes(asset.storageRef) || deleted > 0
    ? fail(`a dry-run sweep reported work over a REFERENCED blob: ${res.text}`)
    : pass(`dry-run sweep left the referenced blob ${asset.storageRef} alone — ${res.text}`);
}

export async function e25SharedAssetSurvivesForget(ctx: Ctx): Promise<Verdict> {
  const shared = ctx.stand.shared;
  if (ctx.stand.forget === null) return skip('the GDPR erasure phase did not run');
  if (!shared) return skip('the co-owned asset was not created');
  if (!knobOn(ctx, 'EVIDENCE_RAW_READ_ENABLED')) return skip('EVIDENCE_RAW_READ_ENABLED is off');
  const res = await bytes(ctx.wire, { path: rawPath(shared) });
  if (res.status !== 200) {
    return fail(
      `an asset still owned by ${ctx.survivorUserId} stopped serving (HTTP ${res.status}) after ` +
        `${ctx.forgetUserId} was erased — a surviving reference lost its bytes`,
    );
  }
  return sha256(res.body) === shared.byteHash
    ? pass("the co-owner's asset kept its bytes through the other owner's erasure")
    : fail(
        `the surviving asset now serves different bytes (${sha256(res.body)} != ${shared.byteHash})`,
      );
}

export function e26SharedBlobDrainer(): Verdict {
  return skip(
    'PRECONDITION UNREACHABLE OVER HTTP. The defect (PR #481, "Follow-up spotted, not fixed ' +
      'here"): the 0114 drainer and the user-forget cascade delete a queued storageRef ' +
      'UNCONDITIONALLY, so a blob shared by two asset rows loses its bytes when one row dies. ' +
      'Two rows can only share a ref through a service-level registerAsset with a foreign ' +
      'storageRef — byteHash is UNIQUE per tenant and the upload path derives the ref from the ' +
      'hash, so no sequence of HTTP calls constructs the shared-ref state. Encoded here as an ' +
      'open finding rather than a green check; closing it needs a unit/e2e test at the seam.',
  );
}

// ── E8 · GDPR ───────────────────────────────────────────────────────

export async function e27ForgetErasesUserEvidence(ctx: Ctx): Promise<Verdict> {
  const forget = ctx.stand.forget;
  const sole = ctx.stand.sole;
  if (forget === null) return skip('the GDPR erasure phase did not run');
  if (forget.status !== 200 && forget.status !== 201) {
    return fail(`POST /v1/users/${ctx.forgetUserId}/forget answered HTTP ${forget.status}`);
  }
  if (!sole) return skip('the sole-owned asset was not created');
  const f = new Findings();
  for (const key of [
    'evidenceAssetsDeleted',
    'evidenceFragmentsDeleted',
    'representationsDeleted',
    'evidenceGrantsDeleted',
  ]) {
    const count = num(forget.json, key) ?? 0;
    f.ok(count >= 1, `${key}=${count}`, `${key}=${count} — the cascade erased nothing there`);
  }
  const asset = await bytes(ctx.wire, { path: rawPath(sole) });
  f.ok(
    asset.status === 404,
    'the erased asset no longer serves',
    `the erased asset still answered HTTP ${asset.status}`,
  );
  if (sole.fragmentId !== null) {
    const frag = await bytes(ctx.wire, { path: fragmentRawPath(sole.fragmentId) });
    f.ok(
      frag.status === 404,
      'its citation target died with it',
      `the erased fragment still answered HTTP ${frag.status}`,
    );
  }
  return f.verdict();
}

export async function e28CoOwnerGrantSurvives(ctx: Ctx): Promise<Verdict> {
  const shared = ctx.stand.shared;
  if (ctx.stand.forget === null) return skip('the GDPR erasure phase did not run');
  if (!shared) return skip('the co-owned asset was not created');
  if (!knobOn(ctx, 'EVIDENCE_GRANTS_API_ENABLED'))
    return skip('EVIDENCE_GRANTS_API_ENABLED is off');
  const listed = await call(ctx.wire, {
    method: 'GET',
    path: `/v1/evidence/${shared.assetId}/grants`,
  });
  if (listed.status !== 200) {
    return fail(`the survivor's asset no longer lists its grants (HTTP ${listed.status})`);
  }
  const owners = arr(listed.json, 'grants').map((g) => str(g, 'ownerId') ?? '');
  const f = new Findings();
  f.ok(
    owners.includes(ctx.survivorUserId),
    `${ctx.survivorUserId} still owns it`,
    `the surviving owner is gone (owners: ${owners.join(', ') || 'none'})`,
  );
  f.ok(
    !owners.includes(ctx.forgetUserId),
    "the erased user's grant is gone",
    `the erased user ${ctx.forgetUserId} still holds a live grant`,
  );
  return f.verdict();
}

export async function e29CoTenantBytesSurvive(ctx: Ctx): Promise<Verdict> {
  const twin = ctx.stand.tenantB;
  if (ctx.wireB === null) {
    return skip('no second tenant configured — set EVEV_TENANT_B_ID and EVEV_TENANT_B_KEY');
  }
  if (ctx.stand.forget === null) return skip('the GDPR erasure phase did not run');
  if (!twin) return skip("tenant B's copy of the bytes was not registered");
  const res = await bytes(ctx.wireB, { path: rawPath(twin) });
  if (res.status !== 200) {
    return fail(
      `tenant B's identical-bytes asset stopped serving (HTTP ${res.status}) after tenant A ` +
        'erased its owner — content-addressed storage leaked across the tenant fence',
    );
  }
  return sha256(res.body) === twin.byteHash
    ? pass("a co-tenant's identical bytes survived the other tenant's erasure intact")
    : fail(`tenant B's bytes changed (${sha256(res.body)} != ${twin.byteHash})`);
}
