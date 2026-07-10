/**
 * POST /v1/admin/policy-sets/explain — single-decision traces for an
 * action and for a real stored fact (row), the API twin of Zep's
 * `zepctl api-key explain` with per-condition expected/actual detail.
 */
import { AppFixture, createApp } from './app-fixture';
import { PolicyExplainResponseSchema } from '../src/contracts/admin/policies.schema';

jest.setTimeout(120_000);

const DOC = {
  name: 'support-reader',
  description: 'readonly + support vertical only',
  posture: { actions: 'deny', reads: 'deny' },
  mode: 'enforce',
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

describe('ABAC explain endpoint', () => {
  let f: AppFixture;
  let hrFactId: string;
  let supportFactId: string;

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    f = await createApp();
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send(DOC);
    expect(created.status).toBe(201);

    const ingest = async (vertical: string, object: string) => {
      const r = await f.http
        .post('/v1/ingest/fact')
        .set({ Authorization: `Bearer ${f.apiKey}` })
        .send({
          entityRef: { vertical: 'rent', id: 'subj_explain' },
          predicate: 'preference',
          object,
          validFrom: '2026-01-01',
          confidence: 0.9,
          source: { vertical, recorder: 'crm' },
        });
      expect([200, 201]).toContain(r.status);
      return r.body.factId as string;
    };
    supportFactId = await ingest('support', 'likes fast replies');
    hrFactId = await ingest('hr', 'salary negotiation notes');
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    await f.close();
  });

  const explain = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/admin/policy-sets/explain')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ policyNames: ['support-reader'], ...body });

  it('explains an allowed action via the readonly macro', async () => {
    const r = await explain({ action: 'search_knowledge' });
    expect(r.status).toBe(201);
    expect(r.body.action).toMatchObject({
      name: 'search_knowledge',
      decision: 'allow',
    });
    expect(r.body.action.traces[0].decidedBy).toBe('ro');
  });

  it('explains a posture-denied action', async () => {
    const r = await explain({ action: 'record_fact' });
    expect(r.status).toBe(201);
    expect(r.body.action.decision).toBe('deny');
    expect(r.body.action.traces[0].decidedBy).toBe('posture');
  });

  it('explains row verdicts with per-condition expected/actual fields', async () => {
    const denied = await explain({ factId: hrFactId });
    expect(denied.status).toBe(201);
    expect(denied.body.row.decision).toBe('deny');
    const trace = denied.body.row.traces[0];
    expect(trace.decidedBy).toBe('posture');
    expect(trace.rules[0]).toMatchObject({ ruleId: 'support-open', matched: false });
    expect(trace.rules[0].fields[0]).toMatchObject({
      attr: 'source.vertical',
      expected: 'support',
      actual: 'hr',
      matched: false,
    });

    const allowed = await explain({ factId: supportFactId });
    expect(allowed.body.row.decision).toBe('allow');
    expect(allowed.body.row.traces[0].decidedBy).toBe('support-open');
    expect(allowed.body.row.view.predicate).toBe('preference');
  });

  it('both at once, and the response matches the wire contract', async () => {
    const r = await explain({ action: 'graph_retrieve', factId: supportFactId });
    expect(r.status).toBe(201);
    const parsed = PolicyExplainResponseSchema.safeParse(r.body);
    if (!parsed.success) {
      throw new Error(`explain drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });

  it('404s on unknown policy names and 400s without a target', async () => {
    const unknown = await explain({ policyNames: ['ghost'], action: 'synthesize' });
    expect(unknown.status).toBe(404);
    const empty = await explain({});
    expect(empty.status).toBe(400);
  });
});
