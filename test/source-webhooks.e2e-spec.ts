/**
 * Inbound webhooks end to end on a REAL SurrealDB (W4.2c): a connection
 * gets an address + secret, the vendor calls it its own way — HubSpot's
 * v3 signature, Pipedrive's basic auth, Bitrix24's application token in
 * a form, Kommo's token in the URL — the call becomes a queued
 * `source_sync` job that fetches the named record through the records
 * door, a changed record moves its fact, a deletion closes it. Wrong
 * signatures are 401, unknown addresses and switched-off webhooks 404,
 * and nothing in a call's body ever reaches memory.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { SourceSyncQueueService } from '../src/source-plane/source-sync-queue.service';
import { startFakeCrm, type FakeCrm } from './fixtures/fake-crm';
import { startFakeCloud, type FakeCloud } from './fixtures/fake-cloud';

const COMPANY = 'co_webhooks_e2e';
const PUBLIC = 'https://brain.example.test';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_WEBHOOKS',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_HUBSPOT',
  'SOURCE_KIND_BITRIX24',
  'SOURCE_KIND_KOMMO',
  'SOURCE_KIND_PIPEDRIVE',
  'SOURCE_OAUTH_HUBSPOT_CLIENT_ID',
  'SOURCE_OAUTH_HUBSPOT_CLIENT_SECRET',
  'SOURCE_OAUTH_HUBSPOT_BASE_URL',
  'SOURCE_OAUTH_PIPEDRIVE_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('source webhooks (e2e)', () => {
  let f: AppFixture;
  let crm: FakeCrm;
  let cloud: FakeCloud;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    crm = await startFakeCrm();
    cloud = await startFakeCloud();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_WEBHOOKS: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_HUBSPOT: '1',
      SOURCE_KIND_BITRIX24: '1',
      SOURCE_KIND_KOMMO: '1',
      SOURCE_KIND_PIPEDRIVE: '1',
      SOURCE_OAUTH_HUBSPOT_CLIENT_ID: 'hs-client',
      SOURCE_OAUTH_HUBSPOT_CLIENT_SECRET: 'hs-app-secret',
      SOURCE_OAUTH_HUBSPOT_BASE_URL: crm.base,
      SOURCE_OAUTH_PIPEDRIVE_BASE_URL: cloud.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: PUBLIC,
    });
    f = await createApp({ companyId: COMPANY });
    seed(crm, cloud);
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
    await crm.close();
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
  const factsOf = async (predicate: string): Promise<string[]> => {
    const facts = await rows<{ object: string }>(
      `SELECT object FROM knowledge_fact WHERE predicate = $p AND status = 'active' AND validUntil = NONE`,
      { p: predicate },
    );
    return facts.map((x) => x.object);
  };
  const connect = (body: Record<string, unknown>) =>
    f.http.post('/v1/admin/source-connections').set(auth()).send(body);
  const setup = (id: string, body: Record<string, unknown> = {}) =>
    f.http.post(`/v1/admin/source-connections/${id}/webhook`).set(auth()).send(body);
  /** The queue is there but no worker runs in the test app: run the job the receipt named. */
  const runQueued = async (runId: string) => {
    const [job] = await rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM job_run WHERE runId = $runId LIMIT 1`,
      { runId },
    );
    expect(job?.payload).toBeTruthy();
    return f.app.get(SourceSyncQueueService).executeFromQueue({
      runId,
      jobType: 'source_sync',
      companyId: COMPANY,
      payload: job!.payload,
      attempts: 1,
      abortSignal: new AbortController().signal,
      workerId: 'test',
    });
  };
  const pathOf = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };

  it('hubspot: the v3-signed call fetches the deal it names; a changed stage moves the fact; a deletion closes it; a bad signature is 401', async () => {
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    const schemes = Object.fromEntries(
      catalog.body.sources.map((s: { sourceId: string; webhook: { scheme: string } | null }) => [
        s.sourceId,
        s.webhook?.scheme ?? null,
      ]),
    );
    expect(schemes).toMatchObject({
      hubspot: 'hubspot',
      pipedrive: 'pipedrive',
      bitrix24: 'bitrix24',
      kommo: 'kommo',
      push: null,
    });
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'hubspot',
      vertical: 'crm',
      label: 'HubSpot',
      config: { entities: ['deal', 'person', 'organization'] },
      credential: 'pat-e2e',
    });
    expect(conn.status).toBe(201);
    expect(conn.body.webhook).toEqual({ enabled: false, lastEventAt: null });
    const hook = await setup(conn.body.id, { secret: 'private-app-client-secret' });
    expect(hook.status).toBe(201);
    expect(hook.body.scheme).toBe('hubspot');
    expect(hook.body.url.startsWith(`${PUBLIC}/v1/source-connections/webhook/`)).toBe(true);
    expect(hook.body.secret).toBe('private-app-client-secret');
    expect(hook.body.notes.join(' ')).toContain(hook.body.url);
    const stored = await rows<{ webhookSecret: string }>(
      `SELECT webhookSecret FROM source_connection WHERE id = <record>$id`,
      { id: conn.body.id },
    );
    expect(stored[0]?.webhookSecret.startsWith('enc:v1:')).toBe(true);
    const view = await f.http.get(`/v1/admin/source-connections/${conn.body.id}`).set(auth());
    expect(view.body.webhook.enabled).toBe(true);

    const call = (events: unknown[], secret: string, ts = Date.now()) => {
      const body = JSON.stringify(events);
      const sig = createHmac('sha256', secret)
        .update(`POST${hook.body.url}${body}${ts}`)
        .digest('base64');
      return f.http
        .post(pathOf(hook.body.url))
        .set('Content-Type', 'application/json')
        .set('X-HubSpot-Signature-v3', sig)
        .set('X-HubSpot-Request-Timestamp', String(ts))
        .send(body);
    };
    const events = [
      { objectId: 7001, subscriptionType: 'deal.propertyChange', propertyName: 'dealstage' },
      { objectId: 7001, subscriptionType: 'deal.creation' },
      // A ticket is a known HubSpot object this connection does not sync: acknowledged, ignored.
      { objectId: 4242, subscriptionType: 'ticket.creation' },
      // Not a CRM object at all: dropped by the scheme.
      { objectId: 4243, subscriptionType: 'conversation.creation' },
    ];
    const bad = await call(events, 'wrong-secret');
    expect(bad.status).toBe(401);
    const stale = await call(events, 'private-app-client-secret', Date.now() - 10 * 60_000);
    expect(stale.status).toBe(401);

    const ok = await call(events, 'private-app-client-secret');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ accepted: 1, ignored: 1 });
    expect(ok.body.runId).toBeTruthy();
    // The app's own secret signs too (an OAuth-app webhook).
    const viaApp = await call(events, 'hs-app-secret');
    expect(viaApp.status).toBe(201);
    expect(await factsOf('crm_memory__deal_stage')).toEqual([]);
    const applied = await runQueued(ok.body.runId);
    expect(applied).toMatchObject({
      received: 1,
      fetched: 1,
      ingested: 1,
      failed: 0,
      ranBy: 'webhook',
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Contract sent']);
    expect(await factsOf('crm_memory__owner')).toContain('Grace Hopper');
    const after = await f.http.get(`/v1/admin/source-connections/${conn.body.id}`).set(auth());
    expect(after.body.webhook.lastEventAt).toBeTruthy();
    expect(after.body.lastSyncAt).toBeNull();

    // The stage changes at HubSpot; the next call re-fetches and the fact moves.
    const deal = crm.hubspot.objects.deals[0]!;
    deal.properties.dealstage = 'closedwon';
    deal.properties.hs_lastmodifieddate = '2026-09-16T10:00:00.000Z';
    crm.hubspot.pipelines[0]!.stages.push({ id: 'closedwon', label: 'Closed won' });
    const moved = await call([events[0]], 'private-app-client-secret');
    const applied2 = await runQueued(moved.body.runId);
    expect(applied2).toMatchObject({ fetched: 1, ingested: 1 });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Closed won']);

    // Same revision again: fetched, deduplicated, nothing written.
    const same = await call([events[0]], 'private-app-client-secret');
    expect(await runQueued(same.body.runId)).toMatchObject({
      fetched: 1,
      deduplicated: 1,
      ingested: 0,
    });

    // Deleted at HubSpot: the fact closes by the connection's delete policy.
    const gone = await call(
      [{ objectId: 7001, subscriptionType: 'deal.deletion' }],
      'private-app-client-secret',
    );
    const applied3 = await runQueued(gone.body.runId);
    expect(applied3).toMatchObject({ gone: 1, fetched: 0 });
    // The stage the last render asserted AND the amount / currency / owner the
    // first render did — every document of the item closes, not the last one.
    expect(applied3.closed).toBeGreaterThanOrEqual(4);
    expect(await factsOf('crm_memory__deal_stage')).toEqual([]);
    expect(await factsOf('crm_memory__deal_amount')).toEqual([]);
    expect(await factsOf('crm_memory__owner')).toEqual([]);

    // Restored at HubSpot, byte-identical: the render deduplicates, so the
    // facts the deletion closed reopen instead of being extracted again.
    const back = await call(
      [{ objectId: 7001, subscriptionType: 'deal.creation' }],
      'private-app-client-secret',
    );
    const applied4 = await runQueued(back.body.runId);
    expect(applied4).toMatchObject({ fetched: 1, deduplicated: 1, ingested: 0 });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Closed won']);
    expect(await factsOf('crm_memory__deal_amount')).toEqual(['40000']);
    expect(await factsOf('crm_memory__owner')).toContain('Grace Hopper');
    const openFacts = await rows<{ validUntil: unknown }>(
      `SELECT validUntil FROM knowledge_fact WHERE predicate = 'crm_memory__deal_stage' AND status = 'active'`,
    );
    expect(openFacts.every((f) => f.validUntil === null || f.validUntil === undefined)).toBe(true);

    // Off: the address answers 404, the view says so.
    const off = await f.http
      .delete(`/v1/admin/source-connections/${conn.body.id}/webhook`)
      .set(auth());
    expect(off.status).toBe(200);
    expect((await call(events, 'private-app-client-secret')).status).toBe(404);
    const viewOff = await f.http.get(`/v1/admin/source-connections/${conn.body.id}`).set(auth());
    expect(viewOff.body.webhook.enabled).toBe(false);
  });

  it('pipedrive: basic auth on the webhook; the v2 event names the person', async () => {
    cloud.pipedrive.apiTokens.add('pd-token-e2e');
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'pipedrive',
      vertical: 'crm',
      label: 'Pipedrive',
      config: {},
      credential: 'pd-token-e2e',
    });
    expect(conn.status).toBe(201);
    const hook = await setup(conn.body.id);
    expect(hook.body.scheme).toBe('pipedrive');
    expect(hook.body.secret.length).toBeGreaterThanOrEqual(16);
    expect(hook.body.url).not.toContain('token=');
    const basic = (pass: string) => `Basic ${Buffer.from(`brain:${pass}`).toString('base64')}`;
    const event = {
      meta: { action: 'change', entity: 'person', entity_id: 88, version: '2.0' },
      data: { id: 88, name: 'SHOULD NOT MATTER' },
    };
    expect(
      (await f.http.post(pathOf(hook.body.url)).set('Authorization', basic('nope')).send(event))
        .status,
    ).toBe(401);
    const ok = await f.http
      .post(pathOf(hook.body.url))
      .set('Authorization', basic(hook.body.secret))
      .send(event);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ accepted: 1, ignored: 0 });
    expect(await runQueued(ok.body.runId)).toMatchObject({ fetched: 1, ingested: 1 });
    expect(await factsOf('crm_memory__job_title')).toContain('Head of Ops');
    // The name came from the vendor's answer, never from the call's body.
    const names = await rows<{ name: string }>(
      `SELECT name FROM knowledge_entity WHERE name = 'SHOULD NOT MATTER'`,
    );
    expect(names).toHaveLength(0);
  });

  it('bitrix24: the outbound webhook form with its application token names the deal; an unknown address is 404', async () => {
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'bitrix24',
      vertical: 'crm',
      label: 'Bitrix24',
      config: { allowPrivate: true, entities: ['deal', 'person', 'organization'] },
      credential: `${crm.base}/rest/1/e2ewebhookcode/`,
    });
    expect(conn.status).toBe(201);
    const hook = await setup(conn.body.id, { secret: 'bx-application-token' });
    expect(hook.body.scheme).toBe('bitrix24');
    const form = (token: string, event = 'ONCRMDEALUPDATE', id = '41') =>
      f.http.post(pathOf(hook.body.url)).type('form').send({
        event,
        'data[FIELDS][ID]': id,
        ts: '1758000000',
        'auth[domain]': 'acme.bitrix24.ru',
        'auth[application_token]': token,
      });
    expect((await form('wrong')).status).toBe(401);
    const ok = await form('bx-application-token');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ accepted: 1 });
    expect(await runQueued(ok.body.runId)).toMatchObject({ fetched: 1, ingested: 1 });
    expect(await factsOf('crm_memory__pipeline')).toContain('Enterprise');
    // A lead event on a connection that does not sync leads is acknowledged and ignored.
    const ignored = await form('bx-application-token', 'ONCRMLEADADD', '9');
    expect(ignored.status).toBe(201);
    expect(ignored.body).toMatchObject({ accepted: 0, ignored: 1, runId: null });
    const unknown = await f.http
      .post('/v1/source-connections/webhook/bm90LWFuLWFkZHJlc3M')
      .type('form')
      .send({ event: 'x' });
    expect(unknown.status).toBe(404);
  });

  it('kommo: the token rides in the URL; leads / contacts / companies from one form', async () => {
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'kommo',
      vertical: 'crm',
      label: 'Kommo',
      config: { baseUrl: crm.base, allowPrivate: true },
      credential: 'llt-e2e',
    });
    expect(conn.status).toBe(201);
    const hook = await setup(conn.body.id);
    expect(hook.body.scheme).toBe('kommo');
    expect(hook.body.url).toContain(`?token=${encodeURIComponent(hook.body.secret)}`);
    const path = pathOf(hook.body.url);
    const body = {
      'leads[update][0][id]': '77',
      'contacts[add][0][id]': '15',
      'contacts[add][0][type]': 'contact',
      'contacts[update][0][id]': '5',
      'contacts[update][0][type]': 'company',
      'account[subdomain]': 'acme',
    };
    expect(
      (await f.http.post(path.replace(hook.body.secret, 'x')).type('form').send(body)).status,
    ).toBe(401);
    const ok = await f.http.post(path).type('form').send(body);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ accepted: 3, ignored: 0 });
    expect(await runQueued(ok.body.runId)).toMatchObject({
      received: 3,
      fetched: 3,
      ingested: 3,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toContain('Negotiation');
    expect(await factsOf('crm_memory__currency')).toContain('EUR');
  });

  it('a connection whose connector has no webhook lane refuses setup; the routes are dark without the flag', async () => {
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'push',
      vertical: 'crm',
      label: 'Push',
      config: {},
    });
    expect(conn.status).toBe(201);
    const refused = await setup(conn.body.id);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/no webhook lane/);
    process.env.SOURCE_WEBHOOKS = '0';
    expect((await setup(conn.body.id)).status).toBe(404);
    expect((await f.http.post('/v1/source-connections/webhook/anything').send({})).status).toBe(
      404,
    );
    process.env.SOURCE_WEBHOOKS = '1';
  });
});

function seed(crm: FakeCrm, cloud: FakeCloud): void {
  const h = crm.hubspot;
  h.tokens.add('pat-e2e');
  h.owners = [{ id: '31', firstName: 'Grace', lastName: 'Hopper' }];
  h.pipelines = [
    {
      id: 'default',
      label: 'Sales Pipeline',
      stages: [{ id: 'contractsent', label: 'Contract sent' }],
    },
  ];
  h.lifecycle = [{ id: 'customer', label: 'Customer' }];
  h.objects.companies = [
    {
      id: '900',
      properties: {
        name: 'Acme Robotics',
        domain: 'acme.test',
        hubspot_owner_id: '31',
        hs_lastmodifieddate: '2026-09-01T10:00:00.000Z',
      },
    },
  ];
  h.objects.contacts = [
    {
      id: '501',
      properties: {
        firstname: 'Ada',
        lastname: 'Lovelace',
        jobtitle: 'CTO',
        hubspot_owner_id: '31',
        lastmodifieddate: '2026-09-02T10:00:00.000Z',
      },
    },
  ];
  h.objects.deals = [
    {
      id: '7001',
      properties: {
        dealname: 'Ledger migration',
        amount: '40000',
        deal_currency_code: 'EUR',
        dealstage: 'contractsent',
        pipeline: 'default',
        hubspot_owner_id: '31',
        hs_is_closed_won: 'false',
        hs_is_closed: 'false',
        hs_lastmodifieddate: '2026-09-15T10:00:00.000Z',
      },
    },
  ];
  h.associations = {
    'deals/contacts': { '7001': ['501'] },
    'deals/companies': { '7001': ['900'] },
    'contacts/companies': { '501': ['900'] },
  };

  const b = crm.bitrix24;
  b.codes.add('e2ewebhookcode');
  b.statuses = [{ ENTITY_ID: 'DEAL_STAGE_5', STATUS_ID: 'C5:PREPARATION', NAME: 'Preparing docs' }];
  b.categories = [{ id: 5, name: 'Enterprise' }];
  b.users = [{ ID: '7', NAME: 'Grace', LAST_NAME: 'Hopper' }];
  b.items = {
    2: [
      {
        id: 41,
        title: 'Warehouse sensors',
        opportunity: '40000.00',
        currencyId: 'EUR',
        stageId: 'C5:PREPARATION',
        categoryId: 5,
        assignedById: 7,
        contactId: 12,
        companyId: 3,
        closed: 'N',
        updatedTime: '2026-09-15T13:00:00+03:00',
      },
    ],
    1: [
      {
        id: 9,
        title: 'Inbound: Zavod',
        statusId: 'IN_PROCESS',
        assignedById: 7,
        updatedTime: '2026-09-10T13:00:00+03:00',
      },
    ],
    3: [
      {
        id: 12,
        name: 'Boris',
        lastName: 'Ivanov',
        post: 'CTO',
        companyId: 3,
        assignedById: 7,
        updatedTime: '2026-09-02T13:00:00+03:00',
      },
    ],
    4: [
      { id: 3, title: 'Zavod Robotics', assignedById: 7, updatedTime: '2026-09-01T13:00:00+03:00' },
    ],
  };

  const k = crm.kommo;
  k.tokens.add('llt-e2e');
  k.currency = 'EUR';
  k.pipelines = [{ id: 10, name: 'Sales', statuses: [{ id: 100, name: 'Negotiation' }] }];
  k.users = [{ id: 7, name: 'Grace Hopper' }];
  k.rows.companies = [
    { id: 5, name: 'Nimbus Foods', responsible_user_id: 7, updated_at: 1_788_300_000 },
  ];
  k.rows.contacts = [
    {
      id: 15,
      name: 'Carla Mendes',
      responsible_user_id: 7,
      custom_fields_values: [{ field_code: 'POSITION', values: [{ value: 'COO' }] }],
      _embedded: { companies: [{ id: 5 }] },
      updated_at: 1_788_400_000,
    },
  ];
  k.rows.leads = [
    {
      id: 77,
      name: 'Cold chain rollout',
      price: 90000,
      status_id: 100,
      pipeline_id: 10,
      responsible_user_id: 7,
      _embedded: { contacts: [{ id: 15, is_main: true }], companies: [{ id: 5 }] },
      updated_at: 1_788_500_000,
    },
  ];

  cloud.pipedrive.users = [{ id: 1, name: 'Owner' }];
  cloud.pipedrive.stages = [{ id: 1, name: 'Qualified', pipeline_id: 1 }];
  cloud.pipedrive.pipelines = [{ id: 1, name: 'Sales' }];
  cloud.pipedrive.persons = [
    {
      id: 88,
      name: 'Linus Ferry',
      job_title: 'Head of Ops',
      owner_id: 1,
      update_time: '2026-09-03 10:00:00',
    },
  ];
}
