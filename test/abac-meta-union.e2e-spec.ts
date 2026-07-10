/**
 * Effective-meta union + backfill end-to-end:
 *   - backfill-meta stamps source.meta onto facts committed before the
 *     projection (simulated by stripping meta first)
 *   - POLICY_META_UNION_ENABLED: a fact whose CORROBORATING origin is
 *     pii-classed is denied even though its own meta is clean
 *   - temporal window: an activeFrom in the future keeps a set inert
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

jest.setTimeout(180_000);

const NO_PII_META = {
  name: 'no-pii-meta',
  description: 'deny facts whose (effective) meta is pii-classed',
  posture: { actions: 'allow', reads: 'allow' },
  mode: 'enforce',
  rules: [
    {
      id: 'meta-pii',
      effect: 'deny',
      kind: 'source',
      match: [{ attr: 'source.meta.data_class', op: 'eq', value: 'pii' }],
    },
  ],
};

describe('ABAC meta union + backfill + temporal windows', () => {
  let f: AppFixture;
  let restrictedKey: string;

  const auth = (key?: string) => ({ Authorization: `Bearer ${key ?? f.apiKey}` });

  const ingestDoc = (text: string, meta: Record<string, unknown>, script: any) => {
    f.extractor.setScript(script)
    return f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        occurredAt: '2026-07-01T10:00:00.000Z',
        contextRef: { vertical: 'notes', recorder: 'sync' },
        text,
        meta,
      });
  };

  beforeAll(async () => {
    process.env.ABAC_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.POLICY_META_UNION_ENABLED = '1';
    f = await createApp({
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], policies: ['no-pii-meta'] },
      ],
    });
    [restrictedKey] = f.extraApiKeys;
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set(auth())
      .send(NO_PII_META);
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    delete process.env.ABAC_ENABLED;
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.POLICY_META_UNION_ENABLED;
    await f.close();
  });

  afterEach(() => {
    f.extractor.setScript(null);
  });

  it('backfill-meta stamps meta onto pre-projection facts (idempotent)', async () => {
    const doc = await ingestDoc(
      'Backfill probe document about Vega Corp.',
      { data_class: 'public', team: 'growth' },
      {
        entities: [{ name: 'Vega Corp', type: 'customer' }],
        facts: [
          { entityIndex: 0, predicate: 'tier', object: 'silver backfill probe', confidence: 0.9 },
        ],
        edges: [],
      },
    );
    expect(doc.status).toBe(201);
    const factId = doc.body.committed.factIds[0] as string;

    // Simulate a pre-projection fact: strip the meta the commit stamped.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(
        `UPDATE knowledge_fact SET source.meta = NONE WHERE id = type::record('knowledge_fact', $id)`,
        { id: factId.replace('knowledge_fact:', '') },
      );
    });

    const first = await f.http
      .post('/v1/admin/policy-sets/backfill-meta')
      .set(auth())
      .send({});
    expect(first.status).toBe(201);
    expect(first.body.factsUpdated).toBeGreaterThanOrEqual(1);

    const second = await f.http
      .post('/v1/admin/policy-sets/backfill-meta')
      .set(auth())
      .send({});
    expect(second.body.factsUpdated).toBe(0); // idempotent

    const explain = await f.http
      .post('/v1/admin/policy-sets/explain')
      .set(auth())
      .send({ policyNames: ['no-pii-meta'], factId });
    expect(explain.body.row.view.source.meta).toEqual({
      data_class: 'public',
      team: 'growth',
    });
  });

  it('meta union: a clean fact corroborated by a pii-classed document is denied', async () => {
    // Incumbent from a PUBLIC document.
    const first = await ingestDoc(
      'Orion Ltd relocated. Their new office is in Berlin.',
      { data_class: 'public' },
      {
        entities: [{ name: 'Orion Ltd', type: 'customer' }],
        facts: [
          // single_active — append_only predicates never corroborate (0047).
          { entityIndex: 0, predicate: 'tier', object: 'office in Berlin', confidence: 0.9 },
        ],
        edges: [],
      },
    );
    expect(first.status).toBe(201);
    const incumbentId = first.body.committed.factIds[0] as string;

    // Same claim from a PII-classed document → corroborates the incumbent.
    const second = await ingestDoc(
      'HR relocation file: Orion Ltd office in Berlin confirmed.',
      { data_class: 'pii' },
      {
        entities: [{ name: 'Orion Ltd', type: 'customer' }],
        facts: [
          { entityIndex: 0, predicate: 'tier', object: 'office in Berlin', confidence: 0.9 },
        ],
        edges: [],
      },
    );
    expect(second.status).toBe(201);

    // The incumbent's own meta stays public — a plain (non-union) row
    // check allows it.
    const explain = await f.http
      .post('/v1/admin/policy-sets/explain')
      .set(auth())
      .send({ policyNames: ['no-pii-meta'], factId: incumbentId });
    expect(explain.body.row.decision).toBe('allow');
    const corrobField = explain.body.row.view.corroboration;
    expect(corrobField?.originKeys?.length ?? 0).toBeGreaterThanOrEqual(1);

    // But search under the policy DROPS it — the union inherits the
    // confirming document's data_class: pii.
    const restricted = await f.http
      .post('/v1/search')
      .set(auth(restrictedKey))
      .send({ query: 'office in Berlin' });
    expect(restricted.status).toBe(201);
    const objects = restricted.body.results.flatMap((h: any) =>
      (h.facts ?? []).map((x: any) => x.object),
    );
    expect(objects).not.toContain('office in Berlin');

    // The unrestricted admin key still sees it.
    const full = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'office in Berlin' });
    expect(
      full.body.results.flatMap((h: any) => (h.facts ?? []).map((x: any) => x.object)),
    ).toContain('office in Berlin');
  });

  it('temporal window: a future activeFrom keeps the set inert', async () => {
    const created = await f.http
      .post('/v1/admin/policy-sets')
      .set(auth())
      .send({
        name: 'future-lockdown',
        posture: { actions: 'deny', reads: 'deny' },
        mode: 'enforce',
        activeFrom: '2030-01-01T00:00:00Z',
        rules: [],
      });
    expect(created.status).toBe(201);

    const attach = await f.http
      .post('/v1/admin/policy-sets/future-lockdown/attachments')
      .set(auth())
      .send({ attach: [`key:sha256:${'a'.repeat(64)}`] });
    expect(attach.status).toBe(201);

    // The restricted key ALSO referencing it would fail closed if the
    // window were ignored; instead simulate: an inline subject with the
    // future window resolves to zero enabled sets.
    const sim = await f.http
      .post('/v1/admin/policy/simulate/actions')
      .set(auth())
      .send({ subject: { policyNames: ['future-lockdown'] } });
    expect(sim.status).toBe(400);
  });
});
