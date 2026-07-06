/**
 * Domain Pack runtime install — end-to-end on a real DB.
 *
 * Proves an admin can install a community/custom pack manifest into ONE tenant
 * at runtime (no redeploy): the pack's namespaced predicates are seeded into the
 * registry, immediately usable for ingest; uninstall deprecates them. Builtin
 * packs are rejected for install/uninstall (they're globally available).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

const MEDICAL_MANIFEST = {
  id: 'medical',
  version: '1.0.0',
  description: 'Medical domain ontology (test pack).',
  predicates: [
    {
      localId: 'diagnosis',
      displayLabel: 'diagnosis',
      description: 'TYPE subject is a patient; value is a diagnosis',
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'sensitive',
      status: 'active',
    },
  ],
};

describe('/v1/admin/packs — runtime Domain Pack install', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_pack_install_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
    });
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('installs a custom pack and seeds its namespaced predicate', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: MEDICAL_MANIFEST });
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe('medical');
    expect(r.body.predicatesSeeded).toBe(1);

    const preds = await f.http.get('/v1/admin/predicates').set(auth());
    const ids = (preds.body.predicates ?? []).map((p: any) => p.predicateId);
    expect(ids).toContain('medical__diagnosis');
  });

  it('makes the installed predicate immediately usable for ingest', async () => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'clinic', id: 'patient_1' },
        predicate: 'medical__diagnosis',
        object: 'seasonal influenza',
        validFrom: '2026-07-01T00:00:00Z',
        source: { vertical: 'clinic' },
      });
    expect([200, 201]).toContain(r.status);
    expect(r.body.outcome).toBe('INSERTED');
  });

  it('lists the installed pack alongside builtins', async () => {
    const r = await f.http.get('/v1/admin/packs').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.available.some((p: any) => p.id === 'code_memory' && p.builtin)).toBe(true);
    const medical = r.body.installed.find((p: any) => p.packId === 'medical');
    expect(medical).toBeDefined();
    expect(medical.predicateCount).toBe(1);
  });

  it('rejects installing a builtin pack id', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: { ...MEDICAL_MANIFEST, id: 'code_memory' } });
    expect(r.status).toBe(400);
  });

  it('rejects an invalid manifest (bad semver)', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: { ...MEDICAL_MANIFEST, id: 'legal', version: '1.0' } });
    expect(r.status).toBe(400);
  });

  it('uninstalls the pack, deprecating its predicates', async () => {
    const del = await f.http.delete('/v1/admin/packs/medical').set(auth());
    expect(del.status).toBe(200);
    expect(del.body.predicatesDeprecated).toBe(1);

    const r = await f.http.get('/v1/admin/packs').set(auth());
    expect(r.body.installed.some((p: any) => p.packId === 'medical')).toBe(false);
  });

  it('rejects uninstalling a builtin pack', async () => {
    const r = await f.http.delete('/v1/admin/packs/code_memory').set(auth());
    expect(r.status).toBe(400);
  });
});
