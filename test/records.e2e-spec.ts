/**
 * Records as facts, end to end on a REAL SurrealDB (W4.2):
 *  - crm_memory installed; a `push` connection; a batch of envelopes →
 *    each record a catalogue row, its render a `source_record` document
 *    with NO general-extractor run, its mapped attributes facts under the
 *    record's own id (externalRef), relations as edges; an unchanged
 *    revision is deduplicated;
 *  - a re-push with a changed stage supersedes the old fact (validUntil),
 *    a renamed contact stays ONE entity, `gone` closes the facts;
 *  - a Pipedrive connection as a connected account (fake provider) walks
 *    deals / persons / organizations into facts with stage / owner names;
 *  - the preview answers before any connection exists.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeCloud, type FakeCloud } from './fixtures/fake-cloud';

const COMPANY = 'co_records_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_PIPEDRIVE',
  'SOURCE_OAUTH_PIPEDRIVE_CLIENT_ID',
  'SOURCE_OAUTH_PIPEDRIVE_CLIENT_SECRET',
  'SOURCE_OAUTH_PIPEDRIVE_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('records door + push + pipedrive (e2e)', () => {
  let f: AppFixture;
  let cloud: FakeCloud;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    cloud = await startFakeCloud();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_PIPEDRIVE: '1',
      SOURCE_OAUTH_PIPEDRIVE_CLIENT_ID: 'pd-client',
      SOURCE_OAUTH_PIPEDRIVE_CLIENT_SECRET: 'pd-secret',
      SOURCE_OAUTH_PIPEDRIVE_BASE_URL: cloud.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    cloud.pipedrive.stages = [{ id: 3, name: 'Negotiation', pipeline_id: 1 }];
    cloud.pipedrive.pipelines = [{ id: 1, name: 'Sales' }];
    cloud.pipedrive.users = [{ id: 9, name: 'Grace Hopper' }];
    cloud.pipedrive.organizations = [
      { id: 7, name: 'Acme Robotics', owner_id: 9, update_time: '2026-09-01 10:00:00' },
    ];
    cloud.pipedrive.persons = [
      {
        id: 12,
        name: 'Ada Lovelace',
        job_title: 'CTO',
        owner_id: 9,
        org_id: 7,
        emails: [{ value: 'ada@acme.test', primary: true }],
        update_time: '2026-09-02 10:00:00',
      },
    ];
    cloud.pipedrive.deals = [
      {
        id: 4812,
        title: 'Ledger migration',
        value: 40000,
        currency: 'EUR',
        status: 'open',
        stage_id: 3,
        owner_id: 9,
        person_id: 12,
        org_id: 7,
        update_time: '2026-09-15 10:00:00',
      },
    ];
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await cloud.close();
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const factsOf = (predicate: string) =>
    rows<{
      object: string;
      validUntil: unknown;
      entityId: unknown;
      entity: unknown;
      subject: unknown;
    }>(
      `SELECT object, validUntil, entityId, entity, subject, createdAt FROM knowledge_fact WHERE predicate = $p ORDER BY createdAt ASC`,
      { p: predicate },
    );

  let pushId = '';
  const deal = (stage: string, name = 'Ledger migration') => ({
    entityType: 'deal',
    externalId: '4812',
    name,
    attributes: { value: 40000, currency: 'EUR', stage, status: 'open' },
    relations: [
      {
        kind: 'organization',
        targetType: 'organization',
        targetExternalId: '7',
        targetName: 'Acme Robotics',
      },
    ],
    updatedAt: stage === 'Proposal' ? '2026-09-10T10:00:00.000Z' : '2026-09-15T10:00:00.000Z',
  });

  it('push: envelopes become catalogue rows, a render without a general run, and facts under the record id', async () => {
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: CRM_MEMORY_PACK, acceptSources: true });
    expect([200, 201]).toContain(install.status);
    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'push',
        vertical: 'crm',
        label: 'Bitrix push',
        config: {
          mapping: {
            deal: {
              fields: {
                value: 'deal_amount',
                currency: 'currency',
                stage: 'deal_stage',
                status: 'deal_status',
              },
            },
          },
        },
      });
    expect(conn.status).toBe(201);
    pushId = conn.body.id;
    const r = await f.http
      .post(`/v1/source-connections/${pushId}/records`)
      .set(auth())
      .send({ records: [deal('Proposal')] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      received: 1,
      ingested: 1,
      deduplicated: 0,
      failed: 0,
      errors: [],
    });
    expect(r.body.runId).toBeTruthy();

    const docs = await rows<{ id: unknown; kind: string; title: string }>(
      `SELECT id, kind, title FROM source_document WHERE kind = 'source_record'`,
    );
    expect(docs).toHaveLength(1);
    const chunks = await rows<{ text: string }>(`SELECT text FROM source_chunk WHERE docId = $id`, {
      id: docs[0]!.id,
    });
    expect(chunks.map((c) => c.text).join('\n')).toContain('stage: Proposal');
    const runs = await rows<{ packId: string }>(`SELECT packId FROM indexer_run`);
    expect(runs.map((x) => x.packId)).not.toContain('_general');
    expect(runs.map((x) => x.packId)).toContain('crm_memory');
    const stage = await factsOf('crm_memory__deal_stage');
    expect(stage.map((x) => x.object)).toEqual(['Proposal']);
    expect(await factsOf('crm_memory__deal_amount')).toHaveLength(1);
    const entities = await rows<{ canonicalName: string; externalRefs: Record<string, unknown> }>(
      `SELECT canonicalName, externalRefs FROM knowledge_entity WHERE canonicalName IN ['Ledger migration', 'Acme Robotics']`,
    );
    expect(entities).toHaveLength(2);
    expect(
      JSON.stringify(entities.find((e) => e.canonicalName === 'Ledger migration')!.externalRefs),
    ).toContain(':deal:4812');
    const edges = await rows<{ kind: string }>(`SELECT kind FROM knowledge_edge`);
    expect(edges.some((e) => e.kind === 'organization')).toBe(true);

    // The same revision again: nothing re-ingested.
    const again = await f.http
      .post(`/v1/source-connections/${pushId}/records`)
      .set(auth())
      .send({ records: [deal('Proposal')] });
    expect(again.body).toMatchObject({ ingested: 0, deduplicated: 1 });
    const items = await f.http.get(`/v1/admin/source-connections/${pushId}/items`).set(auth());
    expect(items.body.items.map((i: { externalId: string }) => i.externalId)).toEqual([
      'deal/4812',
    ]);
  });

  it('a changed stage supersedes the old fact; a renamed record stays one entity; gone closes', async () => {
    const r = await f.http
      .post(`/v1/source-connections/${pushId}/records`)
      .set(auth())
      .send({ records: [deal('Negotiation', 'Ledger migration (Acme)')] });
    expect(r.body).toMatchObject({ ingested: 1 });
    const stage = await factsOf('crm_memory__deal_stage');
    expect(stage.map((x) => x.object).sort()).toEqual(['Negotiation', 'Proposal']);
    const closed = stage.find((x) => x.object === 'Proposal')!;
    const current = stage.find((x) => x.object === 'Negotiation')!;
    expect(closed.validUntil).toBeTruthy();
    expect(current.validUntil ?? null).toBeNull();
    expect(String(closed.entityId ?? closed.entity ?? closed.subject)).toBe(
      String(current.entityId ?? current.entity ?? current.subject),
    );
    const named = await rows<{ canonicalName: string; aliases: string[] }>(
      `SELECT canonicalName, aliases FROM knowledge_entity WHERE externalRefs != NONE AND string::contains(<string>externalRefs, ':deal:4812')`,
    );
    expect(named).toHaveLength(1);

    const gone = await f.http
      .post(`/v1/source-connections/${pushId}/records`)
      .set(auth())
      .send({ records: [], gone: ['deal/4812'] });
    expect(gone.body).toMatchObject({ gone: 1 });
    expect(gone.body.closed).toBeGreaterThanOrEqual(1);
    const after = await factsOf('crm_memory__deal_stage');
    expect(after.every((x) => x.validUntil)).toBe(true);
  });

  it('pipedrive as a connected account: preview, then a sync walks the account into facts with names resolved', async () => {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'pipedrive', connector: 'pipedrive' });
    expect(start.status).toBe(201);
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    cloud.codes.set('pd-code', {});
    const cb = await f.http.get(
      `/v1/source-connections/oauth/callback?state=${encodeURIComponent(state)}&code=pd-code`,
    );
    expect(cb.text).toContain('Connected');
    const exchange = cloud.calls.find((c) => c.path === '/oauth/token')!;
    expect(exchange.auth?.startsWith('Basic ')).toBe(true);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grantId = grants.body.grants.find(
      (g: { provider: string }) => g.provider === 'pipedrive',
    ).id;

    const preview = await f.http
      .post('/v1/admin/source-connections/preview')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'pipedrive',
        config: { connector: 'pipedrive', entities: ['deal'] },
        credential: `oauth:${grantId}`,
      });
    expect(preview.status).toBe(201);
    expect(preview.body.entities[0]).toMatchObject({ type: 'deal', error: null });
    expect(preview.body.entities[0].records[0].facts).toEqual(
      expect.arrayContaining([
        { predicate: 'crm_memory__deal_stage', object: 'Negotiation' },
        { predicate: 'crm_memory__owner', object: 'Grace Hopper' },
      ]),
    );
    expect(preview.body.entities[0].records[0].unmapped).toEqual([]);
    expect(preview.body.entities[0].records[0].dropped).toEqual([]);
    expect(
      await rows(
        `SELECT id FROM source_item WHERE externalId = 'deal/4812' AND connectionId != NONE AND string::contains(<string>connectionId, 'preview')`,
      ),
    ).toEqual([]);

    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'pipedrive',
        vertical: 'crm',
        label: 'Pipedrive',
        config: {},
        credential: `oauth:${grantId}`,
      });
    expect(conn.status).toBe(201);
    const sync = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(sync.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      ingested: 3,
      failed: 0,
    });
    const owners = await factsOf('crm_memory__owner');
    expect(owners.map((x) => x.object)).toEqual(['Grace Hopper', 'Grace Hopper', 'Grace Hopper']);
    // e-mail is PII: it stays in the render, never a seeded fact
    expect(await factsOf('email')).toEqual([]);
    const titles = await factsOf('crm_memory__job_title');
    expect(titles.map((x) => x.object)).toEqual(['CTO']);
    const edges = await rows<{ kind: string }>(`SELECT kind FROM knowledge_edge`);
    expect(edges.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['primary_contact', 'works_at']),
    );
    const again = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      fetched: 0,
    });
  });
});
