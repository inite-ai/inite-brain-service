/**
 * The long tail, end to end on a REAL SurrealDB (W4.2b′): a made-up CRM
 * with an OpenAPI document → the assistant proposes the `rest_records`
 * config (heuristics; no model in e2e) → the preview verifies it by
 * execution against the live API → the connection is created with the
 * proposal → a sync walks every entity into facts with relations named
 * → the second run is incremental. The catalogue lists the `custom`
 * source with no static entities (they are the config).
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeRestApi, type FakeRestApi } from './fixtures/fake-rest-api';

const COMPANY = 'co_rest_records_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_REST_RECORDS',
  'SOURCE_MAPPING_ASSISTANT',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
];

describe('rest_records + mapping assistant (e2e)', () => {
  let f: AppFixture;
  let api: FakeRestApi;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    api = await startFakeRestApi();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_REST_RECORDS: '1',
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
    });
    delete process.env.SOURCE_MAPPING_ASSISTANT;
    f = await createApp({ companyId: COMPANY });
    api.companies = [
      {
        id: 3,
        name: 'Acme Robotics',
        domain: 'acme.test',
        industry: 'Robotics',
        updated_at: '2026-09-01T10:00:00Z',
      },
    ];
    api.contacts = [
      {
        id: 12,
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@acme.test',
        position: 'CTO',
        company_id: 3,
        updated_at: '2026-09-02T12:00:00Z',
      },
    ];
    api.deals = [
      {
        id: 41,
        title: 'Ledger migration',
        amount: 40000,
        currency: 'EUR',
        stage: 'Negotiation',
        status: 'open',
        owner_name: 'Grace Hopper',
        contact_id: 12,
        company_id: 3,
        expected_close: '2026-10-31',
        updated_at: '2026-09-15T10:00:00Z',
        is_deleted: false,
      },
    ];
    api.tickets = [
      {
        id: 7,
        subject: 'Login broken',
        status: 'open',
        priority: 'high',
        contact_id: 12,
        updated_at: '2026-09-10T10:00:00Z',
      },
    ];
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: CRM_MEMORY_PACK, acceptSources: true });
    expect([200, 201]).toContain(install.status);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await api.close();
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const factsOf = async (predicate: string): Promise<string[]> => {
    const facts = await rows<{ object: string }>(
      `SELECT object FROM knowledge_fact WHERE predicate = $p AND validUntil = NONE`,
      { p: predicate },
    );
    return facts.map((x) => x.object);
  };

  it('the catalogue lists the custom source; the assistant proposes from the document; the preview verifies; a sync walks it into facts', async () => {
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    const custom = catalog.body.sources.find(
      (s: { packId: string; sourceId: string }) =>
        s.packId === 'crm_memory' && s.sourceId === 'custom',
    );
    expect(custom).toMatchObject({ connector: 'rest_records', availability: 'ready' });
    expect(custom.records.entities).toEqual([]);

    const assist = await f.http
      .post('/v1/admin/source-connections/assist')
      .set(auth())
      .send({
        packId: 'crm_memory',
        openapi: { url: `${api.base}/openapi.json` },
        allowPrivate: true,
      });
    expect(assist.status).toBe(201);
    expect(assist.body.refined).toBe(false);
    expect(Object.keys(assist.body.endpoints).sort()).toEqual([
      'deal',
      'organization',
      'person',
      'ticket',
    ]);
    expect(assist.body.endpoints.deal).toMatchObject({
      list: { path: '/deals' },
      items: 'data',
      paging: { style: 'cursor', param: 'cursor' },
      incremental: { param: 'updated_since' },
      fields: { id: 'id', name: ['title'], updatedAt: 'updated_at' },
    });
    expect(assist.body.mapping.deal.fields).toMatchObject({
      amount: 'deal_amount',
      stage: 'deal_stage',
      owner_name: 'owner',
    });
    const dealRow = assist.body.entities.find((e: { type: string }) => e.type === 'deal');
    expect(dealRow.reason).toContain('GET /deals');
    expect(dealRow.confidence).toBeGreaterThan(0.8);

    // Companies page by a link the document calls `next`; the heuristic read it as a cursor —
    // the connector follows a URL-valued cursor as a link, so the preview still walks it.
    const config = {
      connector: 'rest_records',
      baseUrl: `${api.base}/api`,
      authScheme: 'header:X-Api-Key',
      allowPrivate: true,
      endpoints: assist.body.endpoints,
      mapping: assist.body.mapping,
    };
    const preview = await f.http
      .post('/v1/admin/source-connections/preview')
      .set(auth())
      .send({ packId: 'crm_memory', sourceId: 'custom', config, credential: api.key });
    expect(preview.status).toBe(201);
    const byType = Object.fromEntries(
      preview.body.entities.map((e: { type: string }) => [e.type, e]),
    );
    expect(byType.deal.error).toBeNull();
    expect(byType.deal.records[0].facts).toEqual(
      expect.arrayContaining([
        { predicate: 'crm_memory__deal_amount', object: '40000' },
        { predicate: 'crm_memory__deal_stage', object: 'Negotiation' },
        { predicate: 'crm_memory__owner', object: 'Grace Hopper' },
      ]),
    );
    expect(byType.deal.records[0].relations).toEqual(
      expect.arrayContaining([
        { kind: 'primary_contact', target: 'Ada Lovelace' },
        { kind: 'organization', target: 'Acme Robotics' },
      ]),
    );
    expect(byType.person.records[0].unmapped).toContain('email');
    expect(byType.organization.error).toBeNull();
    expect(byType.ticket.error).toBeNull();

    const conn = await f.http.post('/v1/admin/source-connections').set(auth()).send({
      packId: 'crm_memory',
      sourceId: 'custom',
      vertical: 'crm',
      label: 'Acme CRM',
      config,
      credential: api.key,
    });
    expect(conn.status).toBe(201);
    expect(JSON.stringify(conn.body)).not.toContain(api.key);
    const sync = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(sync.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 4,
      ingested: 4,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Negotiation']);
    expect(await factsOf('crm_memory__job_title')).toEqual(['CTO']);
    expect(await factsOf('crm_memory__website')).toEqual(['acme.test']);
    expect(await factsOf('email')).toEqual([]);
    const edges = await rows<{ kind: string }>(`SELECT kind FROM knowledge_edge`);
    expect(edges.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['primary_contact', 'organization', 'works_at']),
    );

    api.calls.length = 0;
    const again = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      fetched: 0,
    });
    const dealCall = api.calls.find((c) => c.path.startsWith('/api/deals?'));
    expect(new URL(dealCall!.path, api.base).searchParams.get('updated_since')).toMatch(/^2026-/);
    const ticketCall = api.calls.find((c) => c.path === '/api/tickets/search');
    expect(JSON.parse(ticketCall!.body)).toHaveProperty('since');
  });
});
