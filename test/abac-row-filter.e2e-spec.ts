/**
 * ABAC row-level enforcement end-to-end across read surfaces:
 *   - enforce deny on source.vertical hides matching facts from
 *     search and entity profile while other facts stay visible
 *   - default-deny reads posture with one allow rule
 *   - report_only source rules hide nothing but land row decisions
 *   - GOLDEN: with ABAC_ENABLED=1, a key with no policies gets the
 *     byte-identical search response captured with ABAC_ENABLED=0
 *     (same tenant, same data — the app is rebooted between passes).
 */
import { AppFixture, createApp } from './app-fixture';
import { PolicyDecisionSink } from '../src/policy/policy-decision.sink';
import { SurrealService } from '../src/db/surreal.service';

jest.setTimeout(180_000);

const NO_HR_DOC = {
  name: 'no-hr',
  description: 'hide facts recorded through the hr vertical',
  posture: { actions: 'allow', reads: 'allow' },
  mode: 'enforce',
  rules: [
    {
      id: 'hr-off',
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'source.vertical', op: 'eq', value: 'hr' }],
    },
  ],
};

const SUPPORT_ONLY_DOC = {
  name: 'support-only',
  description: 'default-deny reads, support vertical opened',
  posture: { actions: 'allow', reads: 'deny' },
  mode: 'enforce',
  rules: [
    {
      id: 'support-open',
      effect: 'allow',
      kind: 'source',
      match: [{ attr: 'source.vertical', op: 'eq', value: 'support' }],
    },
  ],
};

const SHADOW_DOC = {
  name: 'shadow-no-hr',
  description: 'report_only twin of no-hr',
  posture: { actions: 'allow', reads: 'allow' },
  mode: 'report_only',
  rules: [
    {
      id: 'hr-off',
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'source.vertical', op: 'eq', value: 'hr' }],
    },
  ],
};

const ENTITY_REF = { vertical: 'rent', id: 'subj_abac_rows' };

async function seedFacts(f: AppFixture): Promise<void> {
  const facts = [
    { predicate: 'preference', object: 'ground floor apartments', source: { vertical: 'support', recorder: 'crm' } },
    { predicate: 'complaint', object: 'noisy ground floor neighbours', source: { vertical: 'hr', recorder: 'hr-sync' } },
  ];
  for (const fact of facts) {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ entityRef: ENTITY_REF, validFrom: '2026-01-01', confidence: 0.9, ...fact });
    expect([200, 201]).toContain(r.status);
  }
}

function objectsOf(searchBody: any): string[] {
  return (searchBody.results ?? [])
    .flatMap((hit: any) => hit.facts ?? [])
    .map((fct: any) => String(fct.object));
}

/**
 * Scores carry a recency-decay factor computed at query time, so two
 * identical searches seconds apart differ in the ~9th decimal. Round
 * every number to 6 dp — far below any behavioral difference the
 * golden test exists to catch (a dropped row, a changed field).
 */
function normalizeNumbers(value: any): any {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeNumbers(v)]),
    );
  }
  return value;
}

describe('ABAC row filter across read surfaces', () => {
  const companyId = `co_abac_rows_${Date.now()}`;
  let baseline: any;

  it('pass 1 (ABAC off): seed facts and capture the golden search response', async () => {
    process.env.ABAC_ENABLED = '0';
    const f = await createApp({ companyId });
    try {
      await seedFacts(f);
      const r = await f.http
        .post('/v1/search')
        .set({ Authorization: `Bearer ${f.apiKey}` })
        .send({ query: 'ground floor' });
      expect(r.status).toBe(201);
      baseline = r.body;
      expect(objectsOf(baseline).length).toBeGreaterThanOrEqual(2);
    } finally {
      await f.close();
    }
  });

  describe('pass 2 (ABAC on): same tenant, policied keys', () => {
    let f: AppFixture;
    let noHrKey: string;
    let supportOnlyKey: string;
    let shadowKey: string;
    let entityId: string;

    beforeAll(async () => {
      process.env.ABAC_ENABLED = '1';
      f = await createApp({
        companyId,
        extraKeys: [
          { scopes: ['brain:read', 'brain:write'], policies: ['no-hr'] },
          { scopes: ['brain:read', 'brain:write'], policies: ['support-only'] },
          { scopes: ['brain:read', 'brain:write'], policies: ['shadow-no-hr'] },
        ],
      });
      [noHrKey, supportOnlyKey, shadowKey] = f.extraApiKeys;
      for (const doc of [NO_HR_DOC, SUPPORT_ONLY_DOC, SHADOW_DOC]) {
        const r = await f.http
          .post('/v1/admin/policy-sets')
          .set({ Authorization: `Bearer ${f.apiKey}` })
          .send(doc);
        expect(r.status).toBe(201);
      }
      const profile = await f.http
        .post('/v1/search')
        .set({ Authorization: `Bearer ${f.apiKey}` })
        .send({ query: 'ground floor' });
      entityId = profile.body.results[0].entityId;
    });

    afterAll(async () => {
      delete process.env.ABAC_ENABLED;
      await f.close();
    });

    it('GOLDEN: a policy-free key gets the exact pre-ABAC response', async () => {
      const r = await f.http
        .post('/v1/search')
        .set({ Authorization: `Bearer ${f.apiKey}` })
        .send({ query: 'ground floor' });
      expect(r.status).toBe(201);
      expect(normalizeNumbers(r.body)).toEqual(normalizeNumbers(baseline));
    });

    it('enforce deny rule hides hr facts from search, keeps support facts', async () => {
      const r = await f.http
        .post('/v1/search')
        .set({ Authorization: `Bearer ${noHrKey}` })
        .send({ query: 'ground floor' });
      expect(r.status).toBe(201);
      const objects = objectsOf(r.body);
      expect(objects).toContain('ground floor apartments');
      expect(objects).not.toContain('noisy ground floor neighbours');
    });

    it('default-deny reads posture: only the allowed vertical survives', async () => {
      const r = await f.http
        .post('/v1/search')
        .set({ Authorization: `Bearer ${supportOnlyKey}` })
        .send({ query: 'ground floor' });
      expect(r.status).toBe(201);
      const objects = objectsOf(r.body);
      expect(objects).toContain('ground floor apartments');
      expect(objects).not.toContain('noisy ground floor neighbours');
    });

    it('entity profile applies the same row gate', async () => {
      const full = await f.http
        .get(`/v1/entities/${encodeURIComponent(entityId)}`)
        .set({ Authorization: `Bearer ${f.apiKey}` });
      expect(full.status).toBe(200);
      const fullObjects = full.body.facts.map((x: any) => x.object);
      expect(fullObjects).toEqual(
        expect.arrayContaining(['ground floor apartments', 'noisy ground floor neighbours']),
      );

      const restricted = await f.http
        .get(`/v1/entities/${encodeURIComponent(entityId)}`)
        .set({ Authorization: `Bearer ${noHrKey}` });
      expect(restricted.status).toBe(200);
      const restrictedObjects = restricted.body.facts.map((x: any) => x.object);
      expect(restrictedObjects).toContain('ground floor apartments');
      expect(restrictedObjects).not.toContain('noisy ground floor neighbours');
    });

    it('entity timeline applies the same row gate', async () => {
      const restricted = await f.http
        .get(`/v1/entities/${encodeURIComponent(entityId)}/timeline`)
        .set({ Authorization: `Bearer ${noHrKey}` });
      expect(restricted.status).toBe(200);
      const objects = restricted.body.events
        .filter((e: any) => e.type === 'fact.recorded')
        .map((e: any) => e.object);
      expect(objects).toContain('ground floor apartments');
      expect(objects).not.toContain('noisy ground floor neighbours');
    });

    it('report_only source rule hides nothing but records a row would_deny aggregate', async () => {
      const r = await f.http
        .post('/v1/search')
        .set({ Authorization: `Bearer ${shadowKey}` })
        .send({ query: 'ground floor' });
      expect(r.status).toBe(201);
      const objects = objectsOf(r.body);
      expect(objects).toContain('noisy ground floor neighbours');

      const sink = f.app.get(PolicyDecisionSink);
      await sink.flushAll();
      const surreal = f.app.get(SurrealService);
      const rows = await surreal.withCompany(f.companyId, async (db) => {
        const [rowsOut] = await db.query<[any[]]>(
          `SELECT * FROM policy_decision
            WHERE kind = 'row' AND decision = 'would_deny'
              AND policySet = 'shadow-no-hr'`,
        );
        return (rowsOut as any[]) ?? [];
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].rowCounts.denied).toBeGreaterThanOrEqual(1);
      expect(rows[0].ruleId).toBe('hr-off');
    });
  });
});
