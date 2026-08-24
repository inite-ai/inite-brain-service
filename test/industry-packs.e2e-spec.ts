/**
 * Industry Domain Pack library — end-to-end. Install fintech / medical / legal
 * into a tenant, confirm their namespaced predicates seed, and run one pack's
 * eval fixtures through the live extractor endpoint. Proves the library is a
 * real, installable, self-verifying set — not just TS constants.
 */
import { FINTECH_PACK, LEGAL_PACK, MEDICAL_PACK } from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('industry domain packs (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_industry_packs_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
    });
    for (const pack of [FINTECH_PACK, MEDICAL_PACK, LEGAL_PACK]) {
      await f.http.post('/v1/admin/packs').set(auth()).send({ manifest: pack });
    }
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('seeds every industry pack namespaced predicate', async () => {
    const preds = await f.http.get('/v1/admin/predicates').set(auth());
    const ids = (preds.body.predicates ?? []).map((p: any) => p.predicateId);
    expect(ids).toEqual(
      expect.arrayContaining([
        'fintech__regulated_by',
        'fintech__complies_with',
        'medical__treats',
        'medical__contraindicated_with',
        'legal__governed_by',
        'legal__obligation',
      ]),
    );
  });

  it('lists them installed alongside the builtin', async () => {
    const r = await f.http.get('/v1/admin/packs').set(auth());
    const installed = (r.body.installed ?? []).map((p: any) => p.packId);
    expect(installed).toEqual(expect.arrayContaining(['fintech', 'medical', 'legal']));
  });

  it('runs an industry pack eval fixture through the live extractor', async () => {
    f.extractor.setScript({
      entities: [{ name: 'Acme Pay', type: 'other' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'fintech__regulated_by',
          object: 'FCA',
          confidence: 0.9,
        },
      ],
      edges: [],
    });
    const r = await f.http.post('/v1/admin/packs/fintech/eval').set(auth());
    expect([200, 201]).toContain(r.status);
    expect(r.body.packId).toBe('fintech');
    expect(r.body.total).toBe(FINTECH_PACK.evalFixtures!.length);
    const regulator = r.body.results.find((x: any) => x.id === 'regulator');
    expect(regulator.passed).toBe(true);
  });
});
