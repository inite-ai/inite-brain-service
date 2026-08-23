/**
 * The Key Lens backend end-to-end: registry, key inventory, search
 * simulation with per-row verdicts (saved sets, inline drafts, keyId
 * subjects), whole-registry action simulation, rule match preview, and
 * the decisions feed + stats.
 */
import { AppFixture, createApp } from './app-fixture';
import { PolicyDecisionSink } from '../src/policy/policy-decision.sink';
import {
  PolicyRegistryResponseSchema,
  SimulateSearchResponseSchema,
} from '../src/contracts/admin/policy-tools.schema';

jest.setTimeout(180_000);

const SUPPORT_READER = {
  name: 'support-reader',
  description: 'readonly, support vertical only',
  posture: { actions: 'deny', reads: 'deny' },
  mode: 'report_only',
  rules: [
    { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
    {
      id: 'support-open',
      effect: 'allow',
      kind: 'source',
      match: [{ attr: 'source.vertical', op: 'eq', value: 'support' }],
    },
  ],
};

describe('ABAC simulation surface', () => {
  let f: AppFixture;
  let attachedKey: string;
  let attachedKeyId: string;

  const auth = (key?: string) => ({ Authorization: `Bearer ${key ?? f.apiKey}` });

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    f = await createApp({
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], policies: ['support-reader'] },
      ],
    });
    attachedKey = f.extraApiKeys[0]!;
    void attachedKey;
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set(auth())
      .send(SUPPORT_READER);
    expect(created.status).toBe(201);

    const facts = [
      { predicate: 'preference', object: 'window seats', source: { vertical: 'support', recorder: 'crm' } },
      { predicate: 'complaint', object: 'window seats too pricey', source: { vertical: 'sales', recorder: 'pipeline' } },
    ];
    for (const fact of facts) {
      const r = await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: 'subj_simulate' },
          validFrom: '2026-01-01',
          confidence: 0.9,
          ...fact,
        });
      expect([200, 201]).toContain(r.status);
    }
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    await f.close();
  });

  it('registry lists actions, macro expansions, and tenant attribute hints', async () => {
    const r = await f.http.get('/v1/admin/policy/registry').set(auth());
    expect(r.status).toBe(200);
    const parsed = PolicyRegistryResponseSchema.safeParse(r.body);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(r.body.actions.length).toBeGreaterThanOrEqual(30);
    const vertical = r.body.attributes.find(
      (a: any) => a.attr === 'source.vertical',
    );
    // Value hints come from source_registry/source_trust and are empty
    // until a source is declared or the trust refit runs — assert the
    // attribute itself, not tenant-dependent hints.
    expect(vertical.ops).toEqual(['eq', 'in']);
    expect(
      r.body.attributes.find((a: any) => a.attr === 'trust.authority')?.ops,
    ).toEqual(['gte', 'gt', 'lte', 'lt']);
    expect(r.body.dynamicAttributes[0].prefix).toBe('source.meta.');
  });

  it('keys inventory shows attachments; keyId works as a simulation subject', async () => {
    const keys = await f.http.get('/v1/admin/keys').set(auth());
    expect(keys.status).toBe(200);
    const restricted = keys.body.keys.find(
      (k: any) => k.policySets.some((s: any) => s.name === 'support-reader'),
    );
    expect(restricted).toBeDefined();
    expect(restricted.policySets[0].mode).toBe('report_only');
    attachedKeyId = restricted.keyId;

    const sim = await f.http
      .post('/v1/admin/policy/simulate/actions')
      .set(auth())
      .send({ subject: { keyId: attachedKeyId } });
    expect(sim.status).toBe(201);
    const record = sim.body.actions.find((a: any) => a.name === 'record_fact');
    // report_only set → the deny surfaces as would_deny, not deny.
    expect(record.decision).toBe('would_deny');
    expect(record.reasons[0]).toMatchObject({ policySet: 'support-reader', kind: 'posture' });
  });

  it('simulate/search returns ALL rows with per-row verdicts (the Key Lens diff)', async () => {
    const r = await f.http
      .post('/v1/admin/policy/simulate/search')
      .set(auth())
      .send({
        subject: { policyNames: ['support-reader'], modeOverride: 'enforce' },
        query: { query: 'window seats' },
      });
    expect(r.status).toBe(201);
    const parsed = SimulateSearchResponseSchema.safeParse(r.body);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));

    expect(r.body.summary.total).toBeGreaterThanOrEqual(2);
    expect(r.body.summary.denied).toBeGreaterThanOrEqual(1);
    const denied = r.body.rows.find((row: any) => row.decision === 'deny');
    const allowed = r.body.rows.find((row: any) => row.decision === 'allow');
    expect(denied.source.vertical).toBe('sales');
    expect(denied.reasons[0].kind).toBe('posture');
    expect(allowed.source.vertical).toBe('support');
    expect(allowed.object).toBe('window seats');
  });

  it('simulate/search accepts an unsaved inline draft', async () => {
    const r = await f.http
      .post('/v1/admin/policy/simulate/search')
      .set(auth())
      .send({
        subject: {
          inline: {
            name: 'draft-probe',
            posture: { actions: 'allow', reads: 'allow' },
            mode: 'enforce',
            rules: [
              {
                id: 'no-sales',
                effect: 'deny',
                kind: 'source',
                match: [{ attr: 'source.vertical', op: 'eq', value: 'sales' }],
              },
            ],
          },
        },
        query: { query: 'window seats' },
      });
    expect(r.status).toBe(201);
    const denied = r.body.rows.filter((row: any) => row.decision === 'deny');
    expect(denied).toHaveLength(1);
    expect(denied[0].reasons[0].detail).toContain('no-sales');
  });

  it('preview-rule returns an approximate match count with samples', async () => {
    const r = await f.http
      .post('/v1/admin/policy/preview-rule')
      .set(auth())
      .send({
        rule: {
          id: 'probe',
          effect: 'deny',
          kind: 'source',
          match: [{ attr: 'source.vertical', op: 'eq', value: 'support' }],
        },
      });
    expect(r.status).toBe(201);
    expect(r.body.matched).toBeGreaterThanOrEqual(1);
    expect(r.body.sampled).toBeGreaterThanOrEqual(r.body.matched);
    expect(r.body.sample[0].source.vertical).toBe('support');
  });

  it('decisions feed + stats surface report_only activity', async () => {
    // Generate would_deny action decisions through the attached key.
    const write = await f.http
      .post('/v1/ingest/fact')
      .set(auth(attachedKey))
      .send({
        entityRef: { vertical: 'rent', id: 'subj_simulate' },
        predicate: 'preference',
        object: 'decision generator',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'support', recorder: 'crm' },
      });
    expect([200, 201]).toContain(write.status);
    await f.app.get(PolicyDecisionSink).flushAll();

    const feed = await f.http
      .get('/v1/admin/policy/decisions?decision=would_deny&kind=action')
      .set(auth());
    expect(feed.status).toBe(200);
    expect(feed.body.decisions.length).toBeGreaterThanOrEqual(1);
    expect(feed.body.decisions[0]).toMatchObject({
      policySet: 'support-reader',
      action: 'record_fact',
      mode: 'report_only',
    });
    expect(feed.body.decisions[0].keyId).toBe(attachedKeyId);

    const stats = await f.http
      .get('/v1/admin/policy/decisions/stats?windowDays=7')
      .set(auth());
    expect(stats.status).toBe(200);
    expect(stats.body.reportOnlySets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'support-reader' }),
      ]),
    );
    expect(
      stats.body.topDeniedActions.find((a: any) => a.action === 'record_fact'),
    ).toBeDefined();
  });
});
