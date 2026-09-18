/**
 * The CRM vendors on the records contract, end to end on a REAL
 * SurrealDB (W4.2b), each against the fake CRM server:
 *  - HubSpot as a connected account: the OAuth flow (client credentials
 *    in the token body, the account label read by the token itself),
 *    then a sync walks deals / contacts / companies into facts with
 *    stage / owner / lifecycle labels and association edges; the
 *    second run is incremental and fetches nothing;
 *  - Bitrix24 on an inbound webhook URL: the credential is stored
 *    encrypted, never echoed by the connection view, the sync walks
 *    the portal into facts;
 *  - Kommo on a long-lived token with `config.baseUrl`: the sync walks
 *    the account; a connection without baseUrl fails by name.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeCrm, type FakeCrm } from './fixtures/fake-crm';

const COMPANY = 'co_crm_vendors_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_HUBSPOT',
  'SOURCE_KIND_BITRIX24',
  'SOURCE_KIND_KOMMO',
  'SOURCE_OAUTH_HUBSPOT_CLIENT_ID',
  'SOURCE_OAUTH_HUBSPOT_CLIENT_SECRET',
  'SOURCE_OAUTH_HUBSPOT_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('CRM vendors: hubspot / bitrix24 / kommo (e2e)', () => {
  let f: AppFixture;
  let crm: FakeCrm;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    crm = await startFakeCrm();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_HUBSPOT: '1',
      SOURCE_KIND_BITRIX24: '1',
      SOURCE_KIND_KOMMO: '1',
      SOURCE_OAUTH_HUBSPOT_CLIENT_ID: 'hs-client',
      SOURCE_OAUTH_HUBSPOT_CLIENT_SECRET: 'hs-secret',
      SOURCE_OAUTH_HUBSPOT_BASE_URL: crm.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seedHubSpot(crm);
    seedBitrix24(crm);
    seedKommo(crm);
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
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  /** Active facts of one predicate, as `object` values (the tenant holds every vendor's facts). */
  const factsOf = async (predicate: string): Promise<string[]> => {
    const facts = await rows<{ object: string }>(
      `SELECT object FROM knowledge_fact WHERE predicate = $p AND validUntil = NONE`,
      { p: predicate },
    );
    return facts.map((x) => x.object);
  };
  const connect = (body: Record<string, unknown>) =>
    f.http.post('/v1/admin/source-connections').set(auth()).send(body);
  const sync = (id: string) =>
    f.http.post(`/v1/admin/source-connections/${id}/sync`).set(auth()).send({ inline: true });

  it('hubspot as a connected account: OAuth with the token body, identity by token, then a sync with labels and edges', async () => {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'hubspot', connector: 'hubspot' });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.origin).toBe(crm.base);
    expect(authorize.searchParams.get('scope')).toContain('crm.objects.deals.read');
    const state = authorize.searchParams.get('state')!;
    crm.hubspot.codes.add('hs-code');
    const cb = await f.http.get(
      `/v1/source-connections/oauth/callback?state=${encodeURIComponent(state)}&code=hs-code`,
    );
    expect(cb.text).toContain('Connected');
    const exchange = crm.calls.find((c) => c.path === '/oauth/v1/token')!;
    expect(exchange.auth).toBeNull();
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe('hs-secret');
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find((g: { provider: string }) => g.provider === 'hubspot');
    expect(grant.account).toBe('owner@example.test');
    expect(crm.calls.some((c) => c.path.startsWith('/oauth/v1/access-tokens/tok_'))).toBe(true);

    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'hubspot',
      vertical: 'crm',
      label: 'HubSpot',
      config: {},
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    expect(conn.body.credentialSource ?? conn.body.grantId).toBeTruthy();
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      ingested: 3,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toContain('Contract sent');
    expect(await factsOf('crm_memory__lifecycle_stage')).toEqual(
      expect.arrayContaining(['Lead', 'Customer']),
    );
    expect(await factsOf('crm_memory__website')).toContain('acme.test');
    const edges = await rows<{ kind: string }>(`SELECT kind FROM knowledge_edge`);
    expect(edges.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['contact', 'organization', 'works_at']),
    );
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      fetched: 0,
    });
    const searches = crm.calls.filter((c) => c.path === '/crm/v3/objects/deals/search');
    const last = JSON.parse(searches.at(-1)!.body) as { filterGroups: unknown[] };
    expect(last.filterGroups).toHaveLength(1);
  });

  it('bitrix24 on an inbound webhook URL: stored encrypted, never shown, the portal walked into facts', async () => {
    const hook = `${crm.base}/rest/1/e2ewebhookcode/`;
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'bitrix24',
      vertical: 'crm',
      label: 'Bitrix24',
      config: { allowPrivate: true, entities: ['deal', 'lead', 'person', 'organization'] },
      credential: hook,
    });
    expect(conn.status).toBe(201);
    expect(JSON.stringify(conn.body)).not.toContain('e2ewebhookcode');
    const stored = await rows<{ credential: string }>(
      `SELECT credential FROM source_connection WHERE id = <record>$id`,
      { id: conn.body.id },
    );
    expect(stored[0]?.credential.startsWith('enc:v1:')).toBe(true);
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 4,
      ingested: 4,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(
      expect.arrayContaining(['Preparing docs', 'In progress']),
    );
    expect(await factsOf('crm_memory__lead_source')).toContain('Web form');
    expect(await factsOf('crm_memory__pipeline')).toContain('Enterprise');
    const listCalls = crm.calls.filter((c) => c.path.endsWith('/crm.item.list.json'));
    expect(listCalls.every((c) => c.method === 'POST' && c.auth === null)).toBe(true);
  });

  it('kommo on a long-lived token: baseUrl names the account; without it the run fails by name', async () => {
    const conn = await connect({
      packId: 'crm_memory',
      sourceId: 'kommo',
      vertical: 'crm',
      label: 'Kommo',
      config: { baseUrl: crm.base, allowPrivate: true },
      credential: 'llt-e2e',
    });
    expect(conn.status).toBe(201);
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      ingested: 3,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toContain('Negotiation');
    expect(await factsOf('crm_memory__currency')).toContain('EUR');
    expect(await factsOf('crm_memory__owner')).toContain('Grace Hopper');
    const leads = crm.calls.find((c) => c.path.startsWith('/api/v4/leads?'));
    expect(leads?.auth).toBe('Bearer llt-e2e');

    const bare = await connect({
      packId: 'crm_memory',
      sourceId: 'kommo',
      vertical: 'crm',
      label: 'Kommo (no account)',
      config: {},
      credential: 'llt-e2e',
    });
    expect(bare.status).toBe(201);
    const failed = await sync(bare.body.id);
    expect(failed.body.summary.status).toBe('failed');
    expect(failed.body.summary.error).toMatch(/config\.baseUrl/);
  });
});

function seedHubSpot(crm: FakeCrm): void {
  const h = crm.hubspot;
  h.owners = [{ id: '31', firstName: 'Grace', lastName: 'Hopper' }];
  h.pipelines = [
    {
      id: 'default',
      label: 'Sales Pipeline',
      stages: [{ id: 'contractsent', label: 'Contract sent' }],
    },
  ];
  h.lifecycle = [
    { id: 'lead', label: 'Lead' },
    { id: 'customer', label: 'Customer' },
  ];
  h.objects.companies = [
    {
      id: '900',
      properties: {
        name: 'Acme Robotics',
        domain: 'acme.test',
        hubspot_owner_id: '31',
        lifecyclestage: 'customer',
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
        email: 'ada@acme.test',
        jobtitle: 'CTO',
        hubspot_owner_id: '31',
        lifecyclestage: 'lead',
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
}

function seedBitrix24(crm: FakeCrm): void {
  const b = crm.bitrix24;
  b.codes.add('e2ewebhookcode');
  b.statuses = [
    { ENTITY_ID: 'DEAL_STAGE_5', STATUS_ID: 'C5:PREPARATION', NAME: 'Preparing docs' },
    { ENTITY_ID: 'STATUS', STATUS_ID: 'IN_PROCESS', NAME: 'In progress' },
    { ENTITY_ID: 'SOURCE', STATUS_ID: 'WEB', NAME: 'Web form' },
  ];
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
        sourceId: 'WEB',
        updatedTime: '2026-09-15T13:00:00+03:00',
      },
    ],
    1: [
      {
        id: 9,
        title: 'Inbound: Zavod',
        statusId: 'IN_PROCESS',
        sourceId: 'WEB',
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
        email: [{ value: 'boris@zavod.test', valueType: 'WORK' }],
        updatedTime: '2026-09-02T13:00:00+03:00',
      },
    ],
    4: [
      {
        id: 3,
        title: 'Zavod Robotics',
        assignedById: 7,
        web: [{ value: 'https://zavod.test', valueType: 'WORK' }],
        updatedTime: '2026-09-01T13:00:00+03:00',
      },
    ],
  };
}

function seedKommo(crm: FakeCrm): void {
  const k = crm.kommo;
  k.tokens.add('llt-e2e');
  k.currency = 'EUR';
  k.pipelines = [{ id: 10, name: 'Sales', statuses: [{ id: 100, name: 'Negotiation' }] }];
  k.users = [{ id: 7, name: 'Grace Hopper' }];
  // Names of their own: a same-named deal in two CRMs is ONE entity to the resolver (by design).
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
      price: 25000,
      responsible_user_id: 7,
      status_id: 100,
      pipeline_id: 10,
      updated_at: 1_789_500_000,
      _embedded: { contacts: [{ id: 15, is_main: true }], companies: [{ id: 5 }] },
    },
  ];
}
