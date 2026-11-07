/**
 * #916 step 1 on a real SurrealDB: a minor's own consent to inference does
 * not count; the operator records age and guardians (a user-bound token
 * cannot); a guardian's grant does count; recording someone a minor, or
 * removing their guardian, erases what a grant that no longer counts
 * produced; user forget erases age and guardian.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ConsentService } from '../src/affect/consent.service';

const U = 'minor_user';
const PURPOSE = 'affect_inference';

describe('minors and guardians (0189)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  let consents: ConsentService;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const self = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: `co_minors_${Date.now()}`,
      extraKeys: [{ scopes: ['brain:read', 'brain:write'], userId: U }],
    });
    surreal = f.app.get(SurrealService);
    consents = f.app.get(ConsentService);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const observation = async () => {
    await surreal.withCompany(f.companyId, async (db) => {
      const [ep] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE episode CONTENT { kind: 'turn', messageId: $m, text: 'x', occurredAt: time::now(),
           userId: $u, source: { vertical: 'chat' } } RETURN id`,
        { u: U, m: `m${Date.now()}` },
      );
      await db.query(
        `CREATE affect_observation CONTENT { userId: $u, episodeId: $e, observedAt: time::now(),
           valence: -0.5, label: 'sadness', quote: 'x', spanStart: 0, spanEnd: 1,
           confidence: 0.7, readerVersion: 'affect-reader-v1' }`,
        { u: U, e: ep![0]!.id },
      );
    });
  };
  const observations = async () =>
    surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `SELECT VALUE id FROM affect_observation WHERE userId = $u`,
        { u: U },
      );
      return (rows ?? []).length;
    });

  it('the person may consent for themselves; while they are not known to be a minor it counts', async () => {
    const r = await f.http
      .post(`/v1/users/${U}/consents`)
      .set(self())
      .send({ purpose: PURPOSE, basis: 'explicit_consent', noticeVersion: 'n-1' });
    expect(r.status).toBe(201);
    expect(r.body.grantedBy).toBe('person');
    expect(await consents.isActive(f.companyId, U, PURPOSE)).toBe(true);
    await observation();
  });

  it('a user-bound token cannot record age, a guardian, or a guardian’s grant', async () => {
    const age = await f.http
      .put(`/v1/users/${U}/age`)
      .set(self())
      .send({ status: 'declared', minor: false, ageBand: 'adult' });
    expect(age.status).toBe(403);
    const guardian = await f.http
      .put(`/v1/users/${U}/guardian`)
      .set(self())
      .send({ guardianRef: 'g' });
    expect(guardian.status).toBe(403);
    const grant = await f.http.post(`/v1/users/${U}/consents`).set(self()).send({
      purpose: PURPOSE,
      basis: 'explicit_consent',
      noticeVersion: 'n-1',
      grantedBy: 'guardian',
    });
    expect(grant.status).toBe(403);
  });

  it('recorded a minor: their own grant stops counting and its inferences are erased', async () => {
    const r = await f.http
      .put(`/v1/users/${U}/age`)
      .set(auth())
      .send({ status: 'verified', minor: true, ageBand: '13_15', method: 'id_check' });
    expect(r.status).toBe(200);
    expect(r.body.age).toMatchObject({ minor: true, status: 'verified', ageBand: '13_15' });
    expect(r.body.erased[PURPOSE]).toMatchObject({ observationsDeleted: 1 });
    expect(await consents.isActive(f.companyId, U, PURPOSE)).toBe(false);
    expect(await observations()).toBe(0);
  });

  it('a guardian grant needs a guardian on record; with one, it counts', async () => {
    const early = await f.http.post(`/v1/users/${U}/consents`).set(auth()).send({
      purpose: PURPOSE,
      basis: 'explicit_consent',
      noticeVersion: 'n-1',
      grantedBy: 'guardian',
    });
    expect(early.status).toBe(400);
    const g = await f.http
      .put(`/v1/users/${U}/guardian`)
      .set(auth())
      .send({ guardianRef: 'parent-77' });
    expect(g.status).toBe(200);
    expect(g.body.guardian.guardianRef).toBe('parent-77');
    const grant = await f.http.post(`/v1/users/${U}/consents`).set(auth()).send({
      purpose: PURPOSE,
      basis: 'explicit_consent',
      noticeVersion: 'n-1',
      grantedBy: 'guardian',
    });
    expect(grant.status).toBe(201);
    expect(await consents.isActive(f.companyId, U, PURPOSE)).toBe(true);
    await observation();
  });

  it('removing the guardian makes their grant stop counting and erases what it allowed', async () => {
    const r = await f.http.delete(`/v1/users/${U}/guardian`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      removed: true,
      erased: { [PURPOSE]: { observationsDeleted: 1 } },
    });
    expect(await consents.isActive(f.companyId, U, PURPOSE)).toBe(false);
  });

  it('the person reads their own age record; forget erases it', async () => {
    const own = await f.http.get(`/v1/users/${U}/age`).set(self());
    expect(own.status).toBe(200);
    expect(own.body.minor).toBe(true);
    const forget = await f.http.post(`/v1/users/${U}/forget`).set(auth());
    expect([200, 201]).toContain(forget.status);
    expect((await f.http.get(`/v1/users/${U}/age`).set(auth())).status).toBe(404);
  });
});
