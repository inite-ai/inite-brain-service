/**
 * #909 step 3 on a real SurrealDB: a person's emotional data is one
 * category they can see, erase and contest on its own, and consent to
 * inference is theirs to give and withdraw.
 *
 *  consent → export (stated + inferred + belief) → contest the inference
 *  (erased, hash kept; a stated fact refuses) → withdraw consent (every
 *  inference erased) → erase the rest → user forget leaves no consent or
 *  contest row.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import { affectStatementHash } from '../src/affect/affect-plane.service';

describe('affect rights (0187)', () => {
  let f: AppFixture;
  let surreal: SurrealService;
  const U = 'affect_rights_user';
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: `co_affrights_${Date.now()}`,
      extraKeys: [{ scopes: ['brain:read', 'brain:write'] }],
    });
    surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE knowledge_predicate CONTENT {
           predicateId: 'relationship__stated_affect', displayLabel: 'stated affect',
           description: 'how the person says they feel', datatype: 'string',
           semantics: 'append_only', piiClass: 'affect', status: 'active', createdBy: 'system' };`,
      );
    });
    f.app.get(PredicateRegistryService).invalidate(f.companyId);
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const fact = async (object: string, source: Record<string, unknown> = {}) => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'chat', id: U },
        predicate: 'relationship__stated_affect',
        object,
        userId: U,
        validFrom: new Date().toISOString(),
        confidence: 0.9,
        source: { vertical: 'chat', recorder: 'test', ...source },
      });
    expect([200, 201]).toContain(r.status);
    return r.body.factId as string;
  };

  const exported = async () => {
    const r = await f.http.get(`/v1/users/${U}/affect`).set(auth());
    expect(r.status).toBe(200);
    return r.body as {
      facts: Array<{ factId: string; statement: string; assertion: string }>;
      beliefs: Array<{ beliefId: string }>;
    };
  };

  let stated: string;
  let inferred: string;

  it('records consent; the list shows it live', async () => {
    const r = await f.http
      .post(`/v1/users/${U}/consents`)
      .set(auth())
      .send({ purpose: 'affect_inference', basis: 'explicit_consent', noticeVersion: 'n-1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ purpose: 'affect_inference', active: true });
    const list = await f.http.get(`/v1/users/${U}/consents`).set(auth());
    expect(list.body.consents).toHaveLength(1);
  });

  it('exports what was said, what was inferred, and affect beliefs — and needs brain:read_pii', async () => {
    stated = await fact('exhausted this week');
    inferred = await fact('sounds flat', {
      assertion: 'inferred',
      inferredBy: { recorder: 'test-reader' },
    });
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `CREATE semantic_belief CONTENT {
           userId: $u, subject: 'person', field: 'mood', value: 'low',
           statement: 'mood has been low', statementSource: 'template', confidence: 0.7,
           revision: 1, status: 'active', validFrom: time::now(),
           sourceSceneIds: [], conversationIds: [], promoterVersion: 'test', piiClass: 'affect' };`,
        { u: U },
      );
    });
    const out = await exported();
    const byId = Object.fromEntries(out.facts.map((x) => [x.factId, x.assertion]));
    expect(byId[stated]).toBe('stated');
    expect(byId[inferred]).toBe('inferred');
    expect(out.beliefs).toHaveLength(1);

    const noPii = await f.http
      .get(`/v1/users/${U}/affect`)
      .set({ Authorization: `Bearer ${f.extraApiKeys[0]}` });
    expect(noPii.status).toBe(403);
  });

  it('contests the inference: erased, its hash kept; a stated fact refuses', async () => {
    const refused = await f.http.post(`/v1/users/${U}/affect/${stated}/contest`).set(auth());
    expect(refused.status).toBe(400);

    const r = await f.http.post(`/v1/users/${U}/affect/${inferred}/contest`).set(auth());
    expect(r.status).toBe(201);
    expect(r.body.erased.factsDeleted).toBe(1);
    const out = await exported();
    expect(out.facts.map((x) => x.factId)).toEqual([stated]);
    const hashes = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[string[]]>(
        `SELECT VALUE statementHash FROM affect_contest WHERE userId = $u`,
        { u: U },
      );
      return rows ?? [];
    });
    expect(hashes).toEqual([affectStatementHash('sounds flat')]);
  });

  it('withdrawing consent erases every inference and keeps what was said', async () => {
    const r = await f.http.delete(`/v1/users/${U}/consents/affect_inference`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ revoked: true, erased: { beliefsDeleted: 1 } });
    const out = await exported();
    expect(out.beliefs).toEqual([]);
    expect(out.facts.map((x) => x.factId)).toEqual([stated]);
    const list = await f.http.get(`/v1/users/${U}/consents`).set(auth());
    expect(list.body.consents[0]).toMatchObject({ active: false });
  });

  it('erase all removes the rest of the category', async () => {
    const r = await f.http.delete(`/v1/users/${U}/affect`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.factsDeleted).toBe(1);
    expect((await exported()).facts).toEqual([]);
  });

  it('user forget leaves no consent or contest row', async () => {
    const r = await f.http.post(`/v1/users/${U}/forget`).set(auth());
    expect([200, 201]).toContain(r.status);
    const left = await surreal.withCompany(f.companyId, async (db) => {
      const [c, k] = await db.query<[unknown[], unknown[]]>(
        `SELECT VALUE id FROM consent_record WHERE userId = $u;
         SELECT VALUE id FROM affect_contest WHERE userId = $u;`,
        { u: U },
      );
      return [...(c ?? []), ...(k ?? [])];
    });
    expect(left).toEqual([]);
  });
});
