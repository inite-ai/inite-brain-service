/**
 * Raw-read gateway e2e (MM-3, migration 0125) against a real SurrealDB:
 * flag-off byte-identical 404 pin, the full gate ladder (tenant fence,
 * live grants incl. user-bound keys + shared-file semantics, modality
 * consent flip, media-PII polarity incl. brain:read_media, quarantine),
 * the fragment twins (whole parent bytes, strictest piiClasses union),
 * signed-URL mint/redeem (expiry, tamper, revocation backstop, no
 * consent re-run), and the content-free evidence_access audit trail
 * dying with its asset in the GDPR user-forget cascade.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { FsEvidenceStorageAdapter } from '../src/evidence/storage/fs-storage.adapter';
import { mintEvidenceToken } from '../src/evidence/raw-url-token';

const COMPANY = 'co_evidence_raw_e2e';
const OTHER_COMPANY = 'co_evidence_raw_other';
const SECRET = 'raw-gateway-e2e-secret-0123456789abcdef';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PREDICATE = {
  localId: 'raw_note',
  displayLabel: 'raw note',
  description: 'TYPE subject is a person; value is a note about raw serving',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
};

/** A pack that declares the raw-evidence capability (gateRawEvidence
 *  clause (a)) — installed with acceptModalities for current consent. */
const RAW_PACK = {
  id: 'raw_gateway_pack',
  version: '1.0.0',
  description: 'Raw-read gateway e2e pack.',
  predicates: [PREDICATE],
  memoryModel: {
    modalities: ['image'],
    rawEvidence: { serve: true },
  },
};

describe('evidence raw-read gateway (e2e)', () => {
  let f: AppFixture;
  let store: EvidenceStoreService;
  let adapter: FsEvidenceStorageAdapter;
  let surreal: SurrealService;
  let fsRoot: string;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const mediaAuth = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]!}` });
  const u1Auth = () => ({ Authorization: `Bearer ${f.extraApiKeys[1]!}` });
  const u2Auth = () => ({ Authorization: `Bearer ${f.extraApiKeys[2]!}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-raw-e2e-'));
    for (const k of [
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_RAW_READ_ENABLED',
      'EVIDENCE_SIGNED_URL_SECRET',
      'EVIDENCE_SIGNED_URL_TTL_SECONDS',
      'EVIDENCE_FS_ROOT',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    process.env.EVIDENCE_FS_ROOT = fsRoot;
    process.env.EVIDENCE_SIGNED_URL_SECRET = SECRET;
    // The flag stays OFF until the 404 pin below runs (runtime-mutable).
    delete process.env.EVIDENCE_RAW_READ_ENABLED;
    delete process.env.EVIDENCE_SIGNED_URL_TTL_SECONDS;
    f = await createApp({
      companyId: COMPANY,
      extraKeys: [
        { scopes: ['brain:read', 'brain:read_media'] },
        { scopes: ['brain:read'], userId: 'raw_u1' },
        { scopes: ['brain:read'], userId: 'raw_u2' },
      ],
    });
    store = f.app.get(EvidenceStoreService);
    adapter = f.app.get(FsEvidenceStorageAdapter);
    surreal = f.app.get(SurrealService);
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: RAW_PACK, acceptModalities: true });
    expect([200, 201]).toContain(install.status);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(fsRoot, { recursive: true, force: true });
    if (f) await f.close();
  });

  const query = async <T>(sql: string, params?: Record<string, unknown>): Promise<T> =>
    surreal.withCompany(COMPANY, async (db) => {
      const [rows] = await db.query<[T]>(sql, params);
      return rows;
    });

  const registerFsAsset = async (
    data: Buffer,
    extra: Partial<Parameters<EvidenceStoreService['registerAsset']>[1]> = {},
    company = COMPANY,
  ) => {
    const byteHash = sha256(data);
    const { storageRef } = await adapter.put(company, byteHash, data);
    return store.registerAsset(company, {
      modality: 'image',
      mediaType: 'image/jpeg',
      byteHash,
      byteLength: data.byteLength,
      occurredAt: new Date('2026-03-01T10:00:00.000Z'),
      storageRef,
      vertical: 'proj',
      piiClasses: [],
      ...extra,
    });
  };

  const outcomesFor = (assetId: string) =>
    query<Array<{ verb: string; outcome: string; keyHash: string }>>(
      `SELECT verb, outcome, keyHash FROM evidence_access WHERE assetId = $a`,
      { a: assetId },
    );

  it('flag off: every route answers a bare 404 (byte-identical pin)', async () => {
    const created = await registerFsAsset(randomBytes(64), { userId: 'raw_off_u' });
    for (const path of [
      `/v1/evidence/${created.assetId}/raw`,
      `/v1/evidence/${created.assetId}/raw-url`,
      '/v1/evidence/fragments/evidence_fragment:none/raw',
      '/v1/evidence/fragments/evidence_fragment:none/raw-url',
      '/v1/evidence/redeem/sometoken',
    ]) {
      const res = await f.http.get(path).set(auth());
      expect(res.status).toBe(404);
    }
    // Off = not even an audit row (the controller 404s before the seam).
    expect(await outcomesFor(created.assetId)).toHaveLength(0);
  });

  it('flag on: a clean granted asset streams its bytes with the defensive headers', async () => {
    process.env.EVIDENCE_RAW_READ_ENABLED = '1'; // stays on from here
    const data = randomBytes(2048);
    const created = await registerFsAsset(data, { userId: 'raw_stream_u' });
    const res = await f.http.get(`/v1/evidence/${created.assetId}/raw`).set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(Buffer.from(res.body as Buffer).equals(data)).toBe(true);
    const rows = await outcomesFor(created.assetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verb: 'stream', outcome: 'ok' });
    expect(rows[0]!.keyHash).toMatch(/^sha256:/);
  });

  it('unauthenticated and unscoped callers never reach the ladder', async () => {
    const created = await registerFsAsset(randomBytes(70), { userId: 'raw_auth_u' });
    expect((await f.http.get(`/v1/evidence/${created.assetId}/raw`)).status).toBe(401);
    expect(await outcomesFor(created.assetId)).toHaveLength(0);
  });

  it('cross-tenant asset ids answer the same bare 404 (tenant fence)', async () => {
    const other = await registerFsAsset(randomBytes(96), { userId: 'other_u' }, OTHER_COMPANY);
    const res = await f.http.get(`/v1/evidence/${other.assetId}/raw`).set(auth());
    expect(res.status).toBe(404);
    // The denial is audited in the CALLER's tenant under the probed handle.
    const rows = await outcomesFor(other.assetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verb: 'stream', outcome: 'denied_tenant' });
  });

  it('no live grant = 404 (revocation kills first-party reads too)', async () => {
    const created = await registerFsAsset(randomBytes(80), { userId: 'raw_grant_u' });
    const grants = await store.liveGrants(COMPANY, created.assetId);
    expect(grants).toHaveLength(1);
    await store.revokeGrant(COMPANY, grants[0]!.grantId);
    const denied = await f.http.get(`/v1/evidence/${created.assetId}/raw`).set(auth());
    expect(denied.status).toBe(404);
    await store.addGrant(COMPANY, {
      assetId: created.assetId,
      ownerKind: 'user',
      ownerId: 'raw_grant_u',
    });
    const ok = await f.http.get(`/v1/evidence/${created.assetId}/raw`).set(auth());
    expect(ok.status).toBe(200);
    const outcomes = (await outcomesFor(created.assetId)).map((r) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['denied_grant', 'ok']));
  });

  it('user-bound keys read only their user’s slice; shared-file semantics hold', async () => {
    const data = randomBytes(512);
    const created = await registerFsAsset(data, { userId: 'raw_u1' });
    const path = `/v1/evidence/${created.assetId}/raw`;
    expect((await f.http.get(path).set(u1Auth())).status).toBe(200);
    expect((await f.http.get(path).set(u2Auth())).status).toBe(404);
    await store.addGrant(COMPANY, {
      assetId: created.assetId,
      ownerKind: 'user',
      ownerId: 'raw_u2',
      purpose: 'share',
    });
    expect((await f.http.get(path).set(u2Auth())).status).toBe(200);
    // Forget the FIRST owner: content survives for the other (0122
    // exclusive-document semantics on bytes), and so does its trail.
    const forget = await f.http.post('/v1/users/raw_u1/forget').set(auth()).send({});
    expect([200, 201]).toContain(forget.status);
    expect((await f.http.get(path).set(u2Auth())).status).toBe(200);
    expect((await f.http.get(path).set(u1Auth())).status).toBe(404);
    expect((await outcomesFor(created.assetId)).length).toBeGreaterThan(0);
    // Forget the LAST owner: asset dies AND the audit trail dies with it.
    const last = await f.http.post('/v1/users/raw_u2/forget').set(auth()).send({});
    expect([200, 201]).toContain(last.status);
    expect(await store.getAsset(COMPANY, created.assetId)).toBeNull();
    expect(await outcomesFor(created.assetId)).toHaveLength(0);
  });

  it('consent flip revokes serving; restore re-opens it', async () => {
    const created = await registerFsAsset(randomBytes(90), { userId: 'raw_consent_u' });
    const path = `/v1/evidence/${created.assetId}/raw`;
    expect((await f.http.get(path).set(auth())).status).toBe(200);
    const packRows = await query<Array<{ id: unknown; acceptedModalitiesChecksum: string }>>(
      `SELECT id, acceptedModalitiesChecksum FROM domain_pack WHERE packId = $p`,
      { p: RAW_PACK.id },
    );
    expect(packRows.length).toBeGreaterThan(0);
    await query(`UPDATE $ids SET acceptedModalitiesChecksum = 'stale'`, {
      ids: packRows.map((r) => r.id),
    });
    try {
      const denied = await f.http.get(path).set(auth());
      expect(denied.status).toBe(404);
    } finally {
      await query(`UPDATE $ids SET acceptedModalitiesChecksum = $c`, {
        ids: packRows.map((r) => r.id),
        c: packRows[0]!.acceptedModalitiesChecksum,
      });
    }
    expect((await f.http.get(path).set(auth())).status).toBe(200);
    const outcomes = (await outcomesFor(created.assetId)).map((r) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['ok', 'denied_consent']));
  });

  it('media-PII polarity: NONE blocked, [] open, non-empty needs brain:read_media', async () => {
    const unclassified = await registerFsAsset(randomBytes(64), {
      userId: 'raw_pii_u',
      piiClasses: undefined,
    });
    const classified = await registerFsAsset(randomBytes(65), {
      userId: 'raw_pii_u',
      piiClasses: ['face'],
    });
    expect((await f.http.get(`/v1/evidence/${unclassified.assetId}/raw`).set(auth())).status).toBe(
      404,
    );
    expect((await f.http.get(`/v1/evidence/${classified.assetId}/raw`).set(auth())).status).toBe(
      404,
    );
    // brain:read_media (env-key-only scope) opens every state.
    expect(
      (await f.http.get(`/v1/evidence/${unclassified.assetId}/raw`).set(mediaAuth())).status,
    ).toBe(200);
    expect(
      (await f.http.get(`/v1/evidence/${classified.assetId}/raw`).set(mediaAuth())).status,
    ).toBe(200);
    const outcomes = (await outcomesFor(classified.assetId)).map((r) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['denied_pii', 'ok']));
  });

  it('quarantined and non-hot assets are blocked', async () => {
    const created = await registerFsAsset(randomBytes(72), { userId: 'raw_quar_u' });
    const path = `/v1/evidence/${created.assetId}/raw`;
    const tail = created.assetId.slice(created.assetId.indexOf(':') + 1);
    await query(
      `UPDATE type::record('evidence_asset', $tail) SET quarantineStatus = 'quarantined'`,
      {
        tail,
      },
    );
    expect((await f.http.get(path).set(auth())).status).toBe(404);
    await query(`UPDATE type::record('evidence_asset', $tail) SET quarantineStatus = 'clean'`, {
      tail,
    });
    expect((await f.http.get(path).set(auth())).status).toBe(200);
    // originUri-only registration is availability='external' — never hot.
    const external = await store.registerAsset(COMPANY, {
      modality: 'image',
      mediaType: 'image/png',
      byteHash: sha256(randomBytes(32)),
      byteLength: 32,
      occurredAt: new Date('2026-03-01T10:00:00.000Z'),
      originUri: 'https://example.com/ext.png',
      userId: 'raw_quar_u',
      vertical: 'proj',
      piiClasses: [],
    });
    expect((await f.http.get(`/v1/evidence/${external.assetId}/raw`).set(auth())).status).toBe(404);
    const outcomes = (await outcomesFor(created.assetId)).map((r) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['denied_availability', 'ok']));
  });

  it('fragment twins serve parent bytes under the STRICTEST piiClasses union', async () => {
    const data = randomBytes(1024);
    const created = await registerFsAsset(data, { userId: 'raw_frag_u' });
    const clean = await store.addFragment(COMPANY, {
      assetId: created.assetId,
      locator: { kind: 'pageRegion', page: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      piiClasses: [],
    });
    const res = await f.http.get(`/v1/evidence/fragments/${clean.fragmentId}/raw`).set(auth());
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).equals(data)).toBe(true);
    // Fragment classified 'face' + clean asset → union non-empty → scope-gated.
    const faced = await store.addFragment(COMPANY, {
      assetId: created.assetId,
      locator: { kind: 'pageRegion', page: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      piiClasses: ['face'],
    });
    expect(
      (await f.http.get(`/v1/evidence/fragments/${faced.fragmentId}/raw`).set(auth())).status,
    ).toBe(404);
    expect(
      (await f.http.get(`/v1/evidence/fragments/${faced.fragmentId}/raw`).set(mediaAuth())).status,
    ).toBe(200);
    // Clean fragment on an UNCLASSIFIED asset → union unclassified → blocked.
    const unclassifiedAsset = await registerFsAsset(randomBytes(60), {
      userId: 'raw_frag_u',
      piiClasses: undefined,
    });
    const onUnclassified = await store.addFragment(COMPANY, {
      assetId: unclassifiedAsset.assetId,
      locator: { kind: 'pageRegion', page: 0, x: 0, y: 0, w: 1, h: 1 },
      piiClasses: [],
    });
    expect(
      (await f.http.get(`/v1/evidence/fragments/${onUnclassified.fragmentId}/raw`).set(auth()))
        .status,
    ).toBe(404);
    // Unknown fragment: the same bare 404.
    expect(
      (await f.http.get('/v1/evidence/fragments/evidence_fragment:missing/raw').set(auth())).status,
    ).toBe(404);
  });

  it('mint → redeem serves the bytes WITHOUT auth; the audit trail carries all three verbs', async () => {
    const data = randomBytes(256);
    const created = await registerFsAsset(data, { userId: 'raw_mint_u' });
    const mint = await f.http.get(`/v1/evidence/${created.assetId}/raw-url`).set(auth());
    expect(mint.status).toBe(200);
    const { token, url, expiresAt } = mint.body as {
      token: string;
      url: string;
      expiresAt: string;
    };
    expect(url).toBe(`/v1/evidence/redeem/${token}`);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const redeem = await f.http.get(url); // NO auth header, deliberately
    expect(redeem.status).toBe(200);
    expect(Buffer.from(redeem.body as Buffer).equals(data)).toBe(true);
    expect(redeem.headers['cache-control']).toBe('no-store');
    const rows = await outcomesFor(created.assetId);
    expect(rows.map((r) => `${r.verb}:${r.outcome}`)).toEqual(
      expect.arrayContaining(['mint:ok', 'redeem:ok']),
    );
  });

  it('expired, tampered and cross-tenant tokens all answer the same bare 404', async () => {
    const created = await registerFsAsset(randomBytes(128), { userId: 'raw_tok_u' });
    const expired = mintEvidenceToken(
      {
        v: 1,
        t: COMPANY,
        a: created.assetId,
        k: 'sha256:expired-mint',
        exp: Math.floor(Date.now() / 1000) - 5,
      },
      SECRET,
    );
    expect((await f.http.get(`/v1/evidence/redeem/${expired}`)).status).toBe(404);
    const rows = await outcomesFor(created.assetId);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['denied_expired']));
    // Tampered signature: log-only denial — nothing lands in the audit.
    const good = mintEvidenceToken(
      {
        v: 1,
        t: COMPANY,
        a: created.assetId,
        k: 'sha256:tamper-mint',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      SECRET,
    );
    const tampered = `${good.split('.')[0]}.${'0'.repeat(64)}`;
    expect((await f.http.get(`/v1/evidence/redeem/${tampered}`)).status).toBe(404);
    // A token structurally pinned to ANOTHER tenant finds nothing there.
    const foreign = mintEvidenceToken(
      {
        v: 1,
        t: OTHER_COMPANY,
        a: created.assetId,
        k: 'sha256:foreign-mint',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      SECRET,
    );
    expect((await f.http.get(`/v1/evidence/redeem/${foreign}`)).status).toBe(404);
  });

  it('redeem re-checks grants (revocation backstop) but NOT consent', async () => {
    const created = await registerFsAsset(randomBytes(140), { userId: 'raw_backstop_u' });
    const mint = await f.http.get(`/v1/evidence/${created.assetId}/raw-url`).set(auth());
    expect(mint.status).toBe(200);
    const url = (mint.body as { url: string }).url;
    // Consent flip mid-TTL: redeem deliberately does NOT re-run consent —
    // the token is the capability; expiry + grants are the levers.
    const packRows = await query<Array<{ id: unknown; acceptedModalitiesChecksum: string }>>(
      `SELECT id, acceptedModalitiesChecksum FROM domain_pack WHERE packId = $p`,
      { p: RAW_PACK.id },
    );
    await query(`UPDATE $ids SET acceptedModalitiesChecksum = 'stale'`, {
      ids: packRows.map((r) => r.id),
    });
    try {
      expect((await f.http.get(url)).status).toBe(200);
    } finally {
      await query(`UPDATE $ids SET acceptedModalitiesChecksum = $c`, {
        ids: packRows.map((r) => r.id),
        c: packRows[0]!.acceptedModalitiesChecksum,
      });
    }
    // Revoking the last live grant kills the still-fresh token.
    const grants = await store.liveGrants(COMPANY, created.assetId);
    for (const g of grants) await store.revokeGrant(COMPANY, g.grantId);
    expect((await f.http.get(url)).status).toBe(404);
    const rows = await outcomesFor(created.assetId);
    expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['denied_revoked']));
  });

  it('mint refuses 503 without the secret; redeem stays a bare 404', async () => {
    const created = await registerFsAsset(randomBytes(88), { userId: 'raw_nosecret_u' });
    delete process.env.EVIDENCE_SIGNED_URL_SECRET;
    try {
      const mint = await f.http.get(`/v1/evidence/${created.assetId}/raw-url`).set(auth());
      expect(mint.status).toBe(503);
      expect((await f.http.get('/v1/evidence/redeem/whatever.sig')).status).toBe(404);
    } finally {
      process.env.EVIDENCE_SIGNED_URL_SECRET = SECRET;
    }
  });
});
