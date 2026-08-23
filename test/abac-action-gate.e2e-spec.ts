/**
 * ABAC action-level enforcement end-to-end:
 *   - enforce policy: 403 policy_denied on gated writes, reads pass
 *   - report_only policy: nothing blocked, would_deny decisions land
 *     in policy_decision
 *   - ABAC_ENABLED=0: policies attached to keys are inert
 *
 * Policy sets are seeded through the real admin CRUD; the restricted
 * keys reference them via the BRAIN_API_KEYS `policies` field (the
 * static-key attachment path).
 */
import { AppFixture, createApp } from './app-fixture';
import { PolicyDecisionSink } from '../src/policy/policy-decision.sink';
import { SurrealService } from '../src/db/surreal.service';

jest.setTimeout(120_000);

const READONLY_DOC = {
  name: 'readonly-agent',
  description: 'default-deny, reads only',
  posture: { actions: 'deny', reads: 'allow' },
  mode: 'enforce',
  rules: [
    { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
  ],
};

const WATCHER_DOC = {
  name: 'watcher',
  description: 'report_only shadow of readonly-agent',
  posture: { actions: 'deny', reads: 'allow' },
  mode: 'report_only',
  rules: [
    { id: 'ro', effect: 'allow', kind: 'action', actions: ['@readonly'] },
  ],
};

describe('ABAC action gate (enforce + report_only)', () => {
  let f: AppFixture;
  let readonlyKey: string;
  let watcherKey: string;

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    f = await createApp({
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], policies: ['readonly-agent'] },
        { scopes: ['brain:read', 'brain:write'], policies: ['watcher'] },
      ],
    });
    readonlyKey = f.extraApiKeys[0]!;
    watcherKey = f.extraApiKeys[1]!;
    for (const doc of [READONLY_DOC, WATCHER_DOC]) {
      const r = await f.http
        .post('/v1/admin/policy-sets')
        .set({ Authorization: `Bearer ${f.apiKey}` })
        .send(doc);
      expect(r.status).toBe(201);
    }
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    await f.close();
  });

  const ingestBody = () => ({
    entityRef: { vertical: 'rent', id: 'subj_abac_gate' },
    predicate: 'preference',
    object: 'quiet street',
    validFrom: '2026-01-01',
    confidence: 0.9,
    source: { vertical: 'rent', recorder: 'bot' },
  });

  it('unrestricted admin key is untouched by ABAC', async () => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send(ingestBody());
    expect([200, 201]).toContain(r.status);
  });

  it('enforce readonly key: search allowed, ingest 403 policy_denied', async () => {
    const search = await f.http
      .post('/v1/search')
      .set({ Authorization: `Bearer ${readonlyKey}` })
      .send({ query: 'quiet street' });
    expect(search.status).toBe(201);

    const write = await f.http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${readonlyKey}` })
      .send(ingestBody());
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({
      error: 'policy_denied',
      action: 'record_fact',
      policySet: 'readonly-agent',
    });
  });

  it('enforce readonly key: undecorated write routes fall to the posture too', async () => {
    // retract is @PolicyAction('retract_fact') — registered write action.
    const r = await f.http
      .post('/v1/facts/whatever/retract')
      .set({ Authorization: `Bearer ${readonlyKey}` })
      .send({ reason: 'test' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('policy_denied');
  });

  it('report_only key: writes pass and a would_deny decision row lands', async () => {
    const write = await f.http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${watcherKey}` })
      .send({ ...ingestBody(), object: 'watched write' });
    expect([200, 201]).toContain(write.status);

    const sink = f.app.get(PolicyDecisionSink);
    await sink.flushAll();
    const surreal = f.app.get(SurrealService);
    const rows = await surreal.withCompany(f.companyId, async (db) => {
      const [r] = await db.query<[any[]]>(
        `SELECT * FROM policy_decision
          WHERE decision = 'would_deny' AND action = 'record_fact'`,
      );
      return (r as any[]) ?? [];
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      kind: 'action',
      mode: 'report_only',
      policySet: 'watcher',
    });
  });

  it('attachments endpoint validates the set exists (fail-closed stays unreachable)', async () => {
    const r = await f.http
      .post('/v1/admin/policy-sets/no-such-set/attachments')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ attach: ['key:sha256:deadbeef'] });
    expect(r.status).toBe(404);
  });

  it('CRUD lifecycle: version conflict 409s with current copy; attached delete 409s', async () => {
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ ...READONLY_DOC, name: 'lifecycle-set' });
    expect(created.status).toBe(201);
    expect(created.body.policySet.version).toBe(1);

    const stale = await f.http
      .put('/v1/admin/policy-sets/lifecycle-set')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ ...READONLY_DOC, name: 'lifecycle-set', version: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.policySet ?? stale.body.current).toBeDefined();

    const attach = await f.http
      .post('/v1/admin/policy-sets/lifecycle-set/attachments')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ attach: ['key:sha256:deadbeef'] });
    expect(attach.status).toBe(201);

    const del = await f.http
      .delete('/v1/admin/policy-sets/lifecycle-set')
      .set({ Authorization: `Bearer ${f.apiKey}` });
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('policy_attached');

    const detach = await f.http
      .post('/v1/admin/policy-sets/lifecycle-set/attachments')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({ detach: ['key:sha256:deadbeef'] });
    expect(detach.status).toBe(201);

    const del2 = await f.http
      .delete('/v1/admin/policy-sets/lifecycle-set')
      .set({ Authorization: `Bearer ${f.apiKey}` });
    expect(del2.status).toBe(200);
  });

  it('rejects an invalid policy document with zod issues', async () => {
    const r = await f.http
      .post('/v1/admin/policy-sets')
      .set({ Authorization: `Bearer ${f.apiKey}` })
      .send({
        name: 'bad-set',
        posture: { actions: 'deny', reads: 'deny' },
        mode: 'enforce',
        rules: [
          { id: 'r', effect: 'deny', kind: 'source', match: [{ attr: 'no.such.attr', op: 'eq', value: 'x' }] },
        ],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_policy_document');
    expect(r.body.issues?.length).toBeGreaterThan(0);
  });
});

describe('ABAC master switch off — attached policies are inert', () => {
  let f: AppFixture;
  let restrictedKey: string;

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '0';
    f = await createApp({
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], policies: ['readonly-agent'] },
      ],
    });
    restrictedKey = f.extraApiKeys[0]!;
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    await f.close();
  });

  it('a key referencing policy sets writes freely when ABAC_ENABLED=0', async () => {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set({ Authorization: `Bearer ${restrictedKey}` })
      .send({
        entityRef: { vertical: 'rent', id: 'subj_abac_off' },
        predicate: 'preference',
        object: 'anything goes',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });
    expect([200, 201]).toContain(r.status);
  });
});
