/**
 * Evidence sharing surface e2e (MM-4, migration 0122) against a real
 * SurrealDB — the HTTP half of test/evidence-grant.e2e-spec.ts, which
 * covers the same seam at service level.
 *
 * The spine is the round trip the surface exists for: an owner GRANTS,
 * the grantee's raw read starts succeeding, the owner REVOKES, and the
 * same read goes back to a bare 404 recorded as `denied_grant` in the
 * content-free evidence_access trail. Around it sit the pins that make
 * the surface safe to ship: the flag-off 404 (raised in a guard, so even
 * a malformed body cannot reveal the route), the identical answers for
 * unknown / foreign / unauthorized subjects, revoke idempotence, and the
 * refusals that keep a client from writing ownership it should not
 * (system grants, unenforceable expiries).
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

const COMPANY = 'co_evidence_grants_api_e2e';
const OTHER_COMPANY = 'co_evidence_grants_api_other';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const PREDICATE = {
  localId: 'grant_note',
  displayLabel: 'grant note',
  description: 'TYPE subject is a person; value is a note about shared evidence',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
};

/** Consent for raw serving — the grantee's READ has to be able to
 *  succeed, or "the grant worked" would be unobservable. */
const RAW_PACK = {
  id: 'grants_api_pack',
  version: '1.0.0',
  description: 'Evidence sharing surface e2e pack.',
  predicates: [PREDICATE],
  memoryModel: { modalities: ['image'], rawEvidence: { serve: true } },
};

describe('evidence sharing surface (e2e)', () => {
  let f: AppFixture;
  let store: EvidenceStoreService;
  let adapter: FsEvidenceStorageAdapter;
  let surreal: SurrealService;
  let fsRoot: string;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const u1Auth = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]!}` });
  const u2Auth = () => ({ Authorization: `Bearer ${f.extraApiKeys[1]!}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'evidence-grants-api-e2e-'));
    for (const k of [
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_GRANTS_API_ENABLED',
      'EVIDENCE_RAW_READ_ENABLED',
      'EVIDENCE_FS_ROOT',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    process.env.EVIDENCE_RAW_READ_ENABLED = '1';
    process.env.EVIDENCE_FS_ROOT = fsRoot;
    // The sharing flag stays OFF until the 404 pin below runs.
    delete process.env.EVIDENCE_GRANTS_API_ENABLED;
    f = await createApp({
      companyId: COMPANY,
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], userId: 'g_u1' },
        { scopes: ['brain:read', 'brain:write'], userId: 'g_u2' },
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

  const outcomesFor = (assetId: string) =>
    query<Array<{ verb: string; outcome: string }>>(
      `SELECT verb, outcome FROM evidence_access WHERE assetId = $a`,
      { a: assetId },
    );

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
      userId: 'g_u1',
      ...extra,
    });
  };

  it('flag off: every route answers a bare 404 — a malformed body included', async () => {
    const created = await registerFsAsset(randomBytes(64));
    const post = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'user', ownerId: 'g_u2' });
    expect(post.status).toBe(404);
    // The guard fires BEFORE the global ValidationPipe: a body that
    // would be a 400 while the surface is on must not advertise it.
    const bad = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ nonsense: true });
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual(post.body);
    expect((await f.http.get(`/v1/evidence/${created.assetId}/grants`).set(u1Auth())).status).toBe(
      404,
    );
    expect((await f.http.delete('/v1/evidence/grants/evidence_grant:x').set(u1Auth())).status).toBe(
      404,
    );
  });

  it('grant → the grantee reads → revoke → the read is denied_grant', async () => {
    process.env.EVIDENCE_GRANTS_API_ENABLED = '1'; // stays on from here
    const data = randomBytes(1024);
    const created = await registerFsAsset(data);
    const raw = `/v1/evidence/${created.assetId}/raw`;
    // Before the share: only the owner reads.
    expect((await f.http.get(raw).set(u1Auth())).status).toBe(200);
    expect((await f.http.get(raw).set(u2Auth())).status).toBe(404);

    const granted = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'user', ownerId: 'g_u2', purpose: 'share' });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({
      created: true,
      assetId: created.assetId,
      retainUntil: null,
    });
    const grantId = (granted.body as { grantId: string }).grantId;

    // The grant is what the read gateway spends.
    const read = await f.http.get(raw).set(u2Auth());
    expect(read.status).toBe(200);
    expect(Buffer.from(read.body as Buffer).equals(data)).toBe(true);

    // Idempotent re-share: the standing row, not a duplicate.
    const again = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'user', ownerId: 'g_u2' });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ grantId, created: false });

    const revoked = await f.http.delete(`/v1/evidence/grants/${grantId}`).set(u1Auth());
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ grantId, revoked: true });
    // Revoke is idempotent — byte-identical answer on the retry.
    const twice = await f.http.delete(`/v1/evidence/grants/${grantId}`).set(u1Auth());
    expect(twice.status).toBe(200);
    expect(twice.body).toEqual(revoked.body);

    expect((await f.http.get(raw).set(u2Auth())).status).toBe(404);
    // The owner is untouched; the grantee's denial is audited as such.
    expect((await f.http.get(raw).set(u1Auth())).status).toBe(200);
    const outcomes = (await outcomesFor(created.assetId)).map((r) => r.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['ok', 'denied_grant']));
  });

  it('unknown, cross-tenant and unauthorized subjects answer IDENTICALLY', async () => {
    const mine = await registerFsAsset(randomBytes(96));
    const foreign = await registerFsAsset(randomBytes(97), { userId: 'other_u' }, OTHER_COMPANY);
    const body = { ownerKind: 'user', ownerId: 'g_u9' };
    // u2 holds no grant on `mine`; the other two subjects do not exist
    // in this tenant at all. All three must be one answer.
    const answers = [
      await f.http.post(`/v1/evidence/${mine.assetId}/grants`).set(u2Auth()).send(body),
      await f.http.post('/v1/evidence/evidence_asset:nope/grants').set(u2Auth()).send(body),
      await f.http.post(`/v1/evidence/${foreign.assetId}/grants`).set(u2Auth()).send(body),
      await f.http.post('/v1/evidence/not-a-record-id/grants').set(u2Auth()).send(body),
    ];
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(answers[0]!.body);
    }
    // ...and the refused share wrote nothing.
    expect(await store.liveGrants(COMPANY, mine.assetId)).toHaveLength(1);
    // The list and revoke verbs are no better a probe.
    const listDeny = await f.http.get(`/v1/evidence/${mine.assetId}/grants`).set(u2Auth());
    expect(listDeny.status).toBe(404);
    expect(listDeny.body).toEqual(answers[0]!.body);
    const own = await store.liveGrants(COMPANY, mine.assetId);
    const revokeDeny = await f.http.delete(`/v1/evidence/grants/${own[0]!.grantId}`).set(u2Auth());
    expect(revokeDeny.status).toBe(404);
    expect(revokeDeny.body).toEqual(answers[0]!.body);
    const unknownGrant = await f.http
      .delete('/v1/evidence/grants/evidence_grant:nope')
      .set(u2Auth());
    expect(unknownGrant.body).toEqual(answers[0]!.body);
  });

  it('the owner lists live grants; a non-owner never sees a grantee handle', async () => {
    const created = await registerFsAsset(randomBytes(128));
    await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'pack', ownerId: 'pack_alpha', purpose: 'processor' });
    const listed = await f.http.get(`/v1/evidence/${created.assetId}/grants`).set(u1Auth());
    expect(listed.status).toBe(200);
    const grants = (listed.body as { grants: Array<{ ownerId: string; ownerKind: string }> })
      .grants;
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => `${g.ownerKind}:${g.ownerId}`).sort()).toEqual([
      'pack:pack_alpha',
      'user:g_u1',
    ]);
    const denied = await f.http.get(`/v1/evidence/${created.assetId}/grants`).set(u2Auth());
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain('pack_alpha');
  });

  it('refuses ownership a client must not write: system grants and fake expiries', async () => {
    const created = await registerFsAsset(randomBytes(64));
    const system = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'system', ownerId: 'system' });
    // A system grant outlives every user's erasure — write-seam only.
    expect(system.status).toBe(400);
    const expiring = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'user', ownerId: 'g_u2', expiresAt: '2030-01-01T00:00:00Z' });
    // 0122 has no grant-expiry column: refuse rather than accept a
    // horizon nothing would enforce.
    expect(expiring.status).toBe(400);
    expect(await store.liveGrants(COMPANY, created.assetId)).toHaveLength(1);
  });

  it('a media-classified asset cannot be shared without brain:read_media', async () => {
    const created = await registerFsAsset(randomBytes(72), { piiClasses: ['face'] });
    const denied = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'user', ownerId: 'g_u2' });
    expect(denied.status).toBe(404);
    expect(await store.liveGrants(COMPANY, created.assetId)).toHaveLength(1);
  });

  it('a tombstoned asset is unshareable (and says nothing about being one)', async () => {
    const created = await registerFsAsset(randomBytes(80));
    await query(`UPDATE type::record('evidence_asset', $tail) SET availability = 'gone'`, {
      tail: created.assetId.slice(created.assetId.indexOf(':') + 1),
    });
    const denied = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .set(u1Auth())
      .send({ ownerKind: 'user', ownerId: 'g_u2' });
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ statusCode: 404 });
    expect(JSON.stringify(denied.body)).not.toContain(created.assetId);
  });

  it('unauthenticated and unscoped callers never reach the ladder', async () => {
    const created = await registerFsAsset(randomBytes(66));
    const anon = await f.http
      .post(`/v1/evidence/${created.assetId}/grants`)
      .send({ ownerKind: 'user', ownerId: 'g_u2' });
    expect(anon.status).toBe(401);
  });
});
