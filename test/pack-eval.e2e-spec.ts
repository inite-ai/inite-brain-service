/**
 * Domain Pack eval fixtures — end-to-end. Install the real_estate pack (which
 * ships evalFixtures), then run `POST /v1/admin/packs/:id/eval` and assert the
 * report. The extractor is the StubExtractor (AppFixture override), scripted to
 * satisfy one fixture — proving manifest → install → run + score wiring.
 */
import { REAL_ESTATE_PACK } from '../src/ai/domain-packs';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('/v1/admin/packs/:id/eval — pack eval fixtures (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_pack_eval_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin'],
    });
    await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: REAL_ESTATE_PACK });
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  it('scores the pack fixtures against the live extractor', async () => {
    // Script the (stub) extractor to satisfy the `zoning` fixture only.
    f.extractor.setScript({
      entities: [{ name: '12 Elm St', type: 'location' }],
      facts: [
        {
          entityIndex: 0,
          predicate: 'real_estate__zoned_as',
          object: 'R-2',
          confidence: 0.9,
        },
      ],
      edges: [],
    });

    const r = await f.http
      .post('/v1/admin/packs/real_estate/eval')
      .set(auth());
    expect(r.status).toBe(201);
    expect(r.body.packId).toBe('real_estate');
    expect(r.body.total).toBe(REAL_ESTATE_PACK.evalFixtures!.length);
    const zoning = r.body.results.find((x: any) => x.id === 'zoning');
    expect(zoning.passed).toBe(true);
    // The other fixtures expect different predicates the script doesn't emit.
    expect(r.body.passed).toBe(1);
    const valuation = r.body.results.find((x: any) => x.id === 'valuation');
    expect(valuation.passed).toBe(false);
    expect(valuation.failures[0]).toMatch(/missing fact real_estate__valued_at/);
  });

  it('404s for a pack that is neither builtin nor installed', async () => {
    f.extractor.setScript(null);
    const r = await f.http.post('/v1/admin/packs/no_such_pack/eval').set(auth());
    expect(r.status).toBe(404);
  });

  it('caps the fixtures run per request (cost bomb guard)', async () => {
    // A pack shipping more than MAX_EVAL_FIXTURES fixtures must run only the
    // cap's worth — each fixture is one live extractor call.
    const fixtures = Array.from({ length: 60 }, (_, i) => ({
      id: `fx_${i}`,
      text: `sample input ${i}`,
      expect: { facts: [{ predicate: 'capcheck__thing' }] },
    }));
    const manifest = {
      id: 'capcheck',
      version: '1.0.0',
      description: 'Cap-guard test pack.',
      predicates: [
        {
          localId: 'thing',
          displayLabel: 'thing',
          description: 'x',
          datatype: 'string',
          semantics: 'append_only',
          decayHalfLifeDays: null,
          piiClass: 'none',
          status: 'active',
        },
      ],
      evalFixtures: fixtures,
    };
    await f.http.post('/v1/admin/packs').set(auth()).send({ manifest });
    f.extractor.setScript(null);

    const r = await f.http.post('/v1/admin/packs/capcheck/eval').set(auth());
    expect(r.status).toBe(201);
    // 60 declared, capped at MAX_EVAL_FIXTURES (50).
    expect(r.body.total).toBe(50);
    expect(r.body.results).toHaveLength(50);
  });
});
