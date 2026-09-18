/**
 * The CRM vendors on the records contract (W4.2b), each against the
 * fake CRM server:
 *  - hubspot: search per object sorted by last-modified with a GTE
 *    window, associations batch-read per page, owners / stages /
 *    lifecycle labels resolved; the 10 000-result cap narrows the
 *    window from the last row's modified-at; a private-app token is a
 *    bearer; `get` reads the inline associations;
 *  - bitrix24: crm.item.list per entityTypeId with `>updatedTime` and
 *    the `start` offset, statuses / categories / users resolved, deal
 *    status from the closed flag + stage semantics, e-mail from the
 *    multifield; the webhook code never appears in an error, a 401 is
 *    reworded for a webhook, a webhook without `user` scope keeps ids;
 *  - kommo: v4 lists with `filter[updated_at][from]`, `page` and
 *    `with=contacts`, 204 ends the walk, statuses / pipelines / users /
 *    loss reasons / the account currency resolved, won / lost folded
 *    from the fixed status ids, custom fields by code;
 *  - the shared timestamp normaliser.
 */
import type { ConnectorCtx, ItemDelta, RecordEnvelope } from '../src/source-plane/connector';
import { Bitrix24Connector, webhookRoot } from '../src/source-plane/connectors/bitrix24.connector';
import { HubSpotConnector } from '../src/source-plane/connectors/hubspot.connector';
import { KommoConnector } from '../src/source-plane/connectors/kommo.connector';
import { isoOf, scalars } from '../src/source-plane/connectors/records-vendor';
import {
  identityUrl,
  providerEndpoints,
  providerSpec,
} from '../src/source-plane/oauth/oauth-providers';
import { startFakeCrm, type FakeCrm } from './fixtures/fake-crm';

const ENV = ['SOURCE_EGRESS_ALLOW_PRIVATE', 'SOURCE_OAUTH_HUBSPOT_BASE_URL'];

let crm: FakeCrm;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  crm = await startFakeCrm();
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
  process.env.SOURCE_OAUTH_HUBSPOT_BASE_URL = crm.base;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await crm.close();
});

function ctxOf(p: {
  connector: string;
  credential: string;
  config?: Record<string, unknown>;
  credentialSource?: 'grant' | 'secret';
}): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: `source_connection:${p.connector}`,
      packId: 'crm_memory',
      sourceId: p.connector,
      kind: 'native',
      connector: p.connector,
      shape: 'structure',
      host: 'server',
      config: p.config ?? {},
      credential: p.credential,
      credentialSource: p.credentialSource ?? 'secret',
      contentPolicy: 'text',
      vertical: 'crm',
      recorder: 'r',
      userId: null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

async function collect(it: AsyncIterable<ItemDelta>) {
  const upserts: Array<{ externalId: string; revision?: string | undefined }> = [];
  let checkpoint: Record<string, unknown> | null = null;
  for await (const d of it) {
    if (d.type === 'upsert')
      upserts.push({ externalId: d.item.externalId, revision: d.item.revision });
    else if (d.type === 'checkpoint') checkpoint = d.checkpoint;
  }
  return { upserts, checkpoint };
}

describe('records-vendor helpers', () => {
  it('normalises every vendor spelling of a timestamp to UTC ISO; a bare date stays a date', () => {
    expect(isoOf('2026-09-15 10:00:00')).toBe('2026-09-15T10:00:00.000Z');
    expect(isoOf('2026-09-15T10:00:00+03:00')).toBe('2026-09-15T07:00:00.000Z');
    expect(isoOf('2026-09-15T10:00:00.000Z')).toBe('2026-09-15T10:00:00.000Z');
    expect(isoOf(1_758_000_000)).toBe('2025-09-16T05:20:00.000Z');
    expect(isoOf('1758000000000')).toBe('2025-09-16T05:20:00.000Z');
    expect(isoOf('2026-10-31')).toBe('2026-10-31');
    expect(isoOf('soon')).toBe('soon');
  });

  it('drops empties and nulls, keeps zero and false', () => {
    expect(scalars({ a: '', b: null, c: undefined, d: 0, e: false, f: 'x' })).toEqual({
      d: 0,
      e: false,
      f: 'x',
    });
  });
});

describe('hubspot', () => {
  const c = new HubSpotConnector();
  const ctx = () =>
    ctxOf({ connector: 'hubspot', credential: 'pat-na1-private', credentialSource: 'secret' });

  beforeAll(() => {
    const h = crm.hubspot;
    h.tokens.add('pat-na1-private');
    h.owners = [{ id: '31', firstName: 'Grace', lastName: 'Hopper' }];
    h.pipelines = [
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: [
          { id: 'appointmentscheduled', label: 'Appointment scheduled' },
          { id: 'contractsent', label: 'Contract sent' },
          { id: 'closedwon', label: 'Closed won' },
        ],
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
          industry: 'ROBOTICS',
          city: 'Tallinn',
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
          closedate: '2026-10-31T00:00:00.000Z',
          hs_deal_stage_probability: '0.6',
          hs_is_closed_won: 'false',
          hs_is_closed: 'false',
          hs_lastmodifieddate: '2026-09-15T10:00:00.000Z',
        },
      },
      {
        id: '7002',
        properties: {
          dealname: 'Old one',
          amount: '100',
          dealstage: 'closedwon',
          pipeline: 'default',
          hs_is_closed_won: 'true',
          hs_is_closed: 'true',
          hs_lastmodifieddate: '2026-09-16T10:00:00.000Z',
        },
      },
    ];
    h.associations = {
      'deals/contacts': { '7001': ['501'] },
      'deals/companies': { '7001': ['900'] },
      'contacts/companies': { '501': ['900'] },
    };
  });

  afterEach(async () => {
    crm.hubspot.pretendCap = false;
    await c.endRun(ctx());
    crm.calls.length = 0;
  });

  it('the provider spec: body-authenticated token endpoint, identity by the token itself, the dev override reroutes the API', () => {
    const spec = providerSpec('hubspot');
    expect(spec.tokenAuth).toBeUndefined();
    expect(identityUrl(spec, 'a/b')).toBe('https://api.hubapi.com/oauth/v1/access-tokens/a%2Fb');
    const ep = providerEndpoints('hubspot');
    expect(ep.apiBase).toBe(crm.base);
    expect(ep.private).toBe(true);
    expect(c.oauth.scopes).toContain('crm.objects.deals.read');
  });

  it('searches per object sorted by last-modified, reads associations per page, resolves labels', async () => {
    const deals = await c.list(ctx(), 'deal', { since: null, page: null });
    expect(deals.records.map((r) => r.externalId)).toEqual(['7001', '7002']);
    expect(deals.records[0]).toMatchObject({
      entityType: 'deal',
      name: 'Ledger migration',
      attributes: {
        amount: 40000,
        currency: 'EUR',
        status: 'open',
        stage: 'Contract sent',
        pipeline: 'Sales Pipeline',
        owner: 'Grace Hopper',
        close_date: '2026-10-31T00:00:00.000Z',
        probability: 0.6,
      },
      relations: [
        { kind: 'contact', targetType: 'person', targetExternalId: '501' },
        { kind: 'organization', targetType: 'organization', targetExternalId: '900' },
      ],
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    expect(deals.records[1]?.attributes).toMatchObject({ status: 'won', stage: 'Closed won' });
    expect(deals.next).toBeNull();
    const search = crm.calls.find((x) => x.path === '/crm/v3/objects/deals/search');
    expect(search?.auth).toBe('Bearer pat-na1-private');
    const body = JSON.parse(search!.body) as {
      sorts: unknown[];
      filterGroups: unknown[];
      limit: number;
    };
    expect(body.sorts).toEqual([{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }]);
    expect(body.filterGroups).toEqual([]);
    expect(body.limit).toBe(200);
    expect(crm.calls.filter((x) => x.path.startsWith('/crm/v4/associations/deals/')).length).toBe(
      2,
    );

    const persons = await c.list(ctx(), 'person', { since: null, page: null });
    expect(persons.records[0]).toMatchObject({
      name: 'Ada Lovelace',
      attributes: { email: 'ada@acme.test', job_title: 'CTO', lifecycle_stage: 'Lead' },
      relations: [{ kind: 'works_at', targetType: 'organization', targetExternalId: '900' }],
    });
    const orgs = await c.list(ctx(), 'organization', {
      since: '2026-09-02T00:00:00.000Z',
      page: null,
    });
    expect(orgs.records).toHaveLength(0);
    const filtered = crm.calls.filter((x) => x.path === '/crm/v3/objects/companies/search').pop();
    expect(JSON.parse(filtered!.body)).toMatchObject({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'hs_lastmodifieddate',
              operator: 'GTE',
              value: String(Date.parse('2026-09-02T00:00:00.000Z')),
            },
          ],
        },
      ],
    });
    // Lookups once per run, not per page.
    expect(crm.calls.filter((x) => x.path.startsWith('/crm/v3/owners')).length).toBe(1);
  });

  it('at the search cap the next page is a fresh window from the last row’s modified-at', async () => {
    crm.hubspot.pretendCap = true;
    const first = await c.list(ctx(), 'deal', { since: null, page: null });
    expect(first.next).toEqual({ after: null, since: '2026-09-16T10:00:00.000Z' });
    const second = await c.list(ctx(), 'deal', { since: null, page: first.next });
    expect(second.records.map((r) => r.externalId)).toEqual(['7002']);
    expect(second.next).toBeNull();
    const walked = await collect(c.enumerate(ctx(), { checkpoint: null, full: true }));
    expect(walked.upserts.map((u) => u.externalId)).toEqual([
      'deal/7001',
      'deal/7002',
      'deal/7002',
      'person/501',
      'organization/900',
    ]);
  });

  it('get reads one object with its inline associations; a missing one is null', async () => {
    const deal = await c.get(ctx(), 'deal', '7001');
    expect(deal?.relations).toEqual([
      { kind: 'contact', targetType: 'person', targetExternalId: '501' },
      { kind: 'organization', targetType: 'organization', targetExternalId: '900' },
    ]);
    expect(await c.get(ctx(), 'deal', '404')).toBeNull();
    const fetched = (await c.fetch(ctx(), { externalId: 'deal/7001' })) as {
      record: RecordEnvelope;
      mapping: { fields: Record<string, string> };
    };
    expect(fetched.record.relations?.map((r) => r.targetName)).toEqual([
      'Ada Lovelace',
      'Acme Robotics',
    ]);
    expect(fetched.mapping.fields.stage).toBe('deal_stage');
    expect(c.preset.person!.fields).not.toHaveProperty('email');
  });
});

describe('bitrix24', () => {
  const c = new Bitrix24Connector();
  const hook = () => `${crm.base}/rest/1/s3cr3tc0de/`;
  const ctx = (credential = hook()) =>
    ctxOf({ connector: 'bitrix24', credential, config: { allowPrivate: true } });

  beforeAll(() => {
    const b = crm.bitrix24;
    b.codes.add('s3cr3tc0de');
    b.statuses = [
      { ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'NEW', NAME: 'New' },
      { ENTITY_ID: 'DEAL_STAGE', STATUS_ID: 'WON', NAME: 'Deal won' },
      { ENTITY_ID: 'DEAL_STAGE_5', STATUS_ID: 'C5:PREPARATION', NAME: 'Preparing docs' },
      { ENTITY_ID: 'STATUS', STATUS_ID: 'IN_PROCESS', NAME: 'In progress' },
      { ENTITY_ID: 'SOURCE', STATUS_ID: 'WEB', NAME: 'Web form' },
      { ENTITY_ID: 'INDUSTRY', STATUS_ID: 'IT', NAME: 'IT' },
    ];
    b.categories = [
      { id: 0, name: 'General' },
      { id: 5, name: 'Enterprise' },
    ];
    b.users = [{ ID: '7', NAME: 'Grace', LAST_NAME: 'Hopper' }];
    b.items = {
      2: [
        {
          id: 41,
          title: 'Ledger migration',
          opportunity: '40000.00',
          currencyId: 'EUR',
          stageId: 'C5:PREPARATION',
          categoryId: 5,
          assignedById: 7,
          contactId: 12,
          companyId: 3,
          closed: 'N',
          probability: 60,
          closedate: '2026-10-31T00:00:00+03:00',
          sourceId: 'WEB',
          createdTime: '2026-08-01T09:00:00+03:00',
          updatedTime: '2026-09-15T13:00:00+03:00',
        },
        {
          id: 42,
          title: 'Won one',
          stageId: 'WON',
          categoryId: 0,
          closed: 'Y',
          updatedTime: '2026-09-16T13:00:00+03:00',
        },
      ],
      1: [
        {
          id: 9,
          title: 'Inbound: Acme',
          statusId: 'IN_PROCESS',
          opportunity: 500,
          currencyId: 'EUR',
          sourceId: 'WEB',
          assignedById: 7,
          companyTitle: 'Acme',
          updatedTime: '2026-09-10T13:00:00+03:00',
        },
      ],
      3: [
        {
          id: 12,
          name: 'Ada',
          lastName: 'Lovelace',
          post: 'CTO',
          companyId: 3,
          assignedById: 7,
          email: [{ value: 'ada@acme.test', valueType: 'WORK' }],
          phone: [],
          updatedTime: '2026-09-02T13:00:00+03:00',
        },
      ],
      4: [
        {
          id: 3,
          title: 'Acme Robotics',
          industry: 'IT',
          web: [{ value: 'https://acme.test', valueType: 'WORK' }],
          assignedById: 7,
          updatedTime: '2026-09-01T13:00:00+03:00',
        },
      ],
    };
  });

  afterEach(async () => {
    await c.endRun(ctx());
    crm.calls.length = 0;
  });

  it('the webhook URL is validated by shape and normalised to the method root', () => {
    expect(webhookRoot('https://acme.bitrix24.ru/rest/1/abc123')).toBe(
      'https://acme.bitrix24.ru/rest/1/abc123/',
    );
    expect(() => webhookRoot('https://acme.bitrix24.ru/')).toThrow(/inbound webhook URL/);
    expect(() => webhookRoot('not a url')).toThrow(/not an inbound webhook URL/);
    expect(() => webhookRoot(null)).toThrow(/no inbound webhook URL/);
  });

  it('lists crm.item per entity with >updatedTime, resolves statuses / categories / users, folds the deal status', async () => {
    const deals = await c.list(ctx(), 'deal', { since: null, page: null });
    expect(deals.records[0]).toMatchObject({
      entityType: 'deal',
      externalId: '41',
      name: 'Ledger migration',
      attributes: {
        amount: 40000,
        currency: 'EUR',
        status: 'open',
        stage: 'Preparing docs',
        pipeline: 'Enterprise',
        owner: 'Grace Hopper',
        probability: 60,
        close_date: '2026-10-30T21:00:00.000Z',
        source: 'Web form',
      },
      relations: [
        { kind: 'primary_contact', targetType: 'person', targetExternalId: '12' },
        { kind: 'organization', targetType: 'organization', targetExternalId: '3' },
      ],
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    expect(deals.records[1]?.attributes).toMatchObject({
      status: 'won',
      stage: 'Deal won',
      pipeline: 'General',
    });
    const leads = await c.list(ctx(), 'lead', { since: null, page: null });
    expect(leads.records[0]).toMatchObject({
      entityType: 'lead',
      name: 'Inbound: Acme',
      attributes: { status: 'In progress', amount: 500, source: 'Web form', company_title: 'Acme' },
    });
    const persons = await c.list(ctx(), 'person', { since: null, page: null });
    expect(persons.records[0]).toMatchObject({
      name: 'Ada Lovelace',
      attributes: { email: 'ada@acme.test', job_title: 'CTO', owner: 'Grace Hopper' },
      relations: [{ kind: 'works_at', targetType: 'organization', targetExternalId: '3' }],
    });
    const orgs = await c.list(ctx(), 'organization', { since: null, page: null });
    expect(orgs.records[0]?.attributes).toMatchObject({
      industry: 'IT',
      website: 'https://acme.test',
    });
    const later = await c.list(ctx(), 'deal', { since: '2026-09-16T00:00:00.000Z', page: null });
    expect(later.records.map((r) => r.externalId)).toEqual(['42']);
    const call = crm.calls.filter((x) => x.path.endsWith('crm.item.list.json')).pop();
    expect(call?.method).toBe('POST');
    expect(call?.auth).toBeNull();
    expect(JSON.parse(call!.body)).toMatchObject({
      entityTypeId: 2,
      filter: { '>updatedTime': '2026-09-16T00:00:00.000Z' },
      order: { updatedTime: 'ASC' },
      start: 0,
    });
    expect(crm.calls.filter((x) => x.path.endsWith('crm.status.list.json')).length).toBe(1);
  });

  it('the whole runtime walks the portal; leads are off by default; get names an unlisted target', async () => {
    const walked = await collect(c.enumerate(ctx(), { checkpoint: null, full: true }));
    expect(walked.upserts.map((u) => u.externalId)).toEqual([
      'deal/41',
      'deal/42',
      'person/12',
      'organization/3',
    ]);
    expect(await c.get(ctx(), 'lead', '9')).toMatchObject({ name: 'Inbound: Acme' });
    expect(await c.get(ctx(), 'lead', '404')).toBeNull();
  });

  it('a wrong code is a 401 reworded for a webhook and the code never appears; without user scope ids stay ids', async () => {
    await expect(
      c.list(ctx(`${crm.base}/rest/1/wrongcode/`), 'deal', { since: null, page: null }),
    ).rejects.toThrow(/inbound webhook was rejected \(401\)/);
    let msg = '';
    try {
      await c.list(ctx(), 'nope', { since: null, page: null });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/unknown entity/);
    // A method the portal refuses: the error names the method, masks the code.
    const users = crm.bitrix24.users;
    crm.bitrix24.users = null;
    const other = new Bitrix24Connector();
    const orgs = await other.list(ctx(), 'organization', { since: null, page: null });
    expect(orgs.records[0]?.attributes.owner).toBeUndefined();
    crm.bitrix24.users = users;
    await other.endRun(ctx());
    // The secret is masked in a transport error (a 403 names the URL).
    crm.bitrix24.failNext = 403;
    const failing = new Bitrix24Connector();
    let masked = '';
    try {
      await failing.list(ctx(), 'deal', { since: null, page: null });
    } catch (e) {
      masked = (e as Error).message;
    }
    expect(masked).not.toContain('s3cr3tc0de');
    expect(masked).toMatch(
      /^bitrix24: crm\.item\.list — forbidden \(403\) at .*\/rest\/1\/\*\*\*\//,
    );
  });
});

describe('kommo', () => {
  const c = new KommoConnector();
  const ctx = () =>
    ctxOf({
      connector: 'kommo',
      credential: 'llt-1',
      config: { baseUrl: crm.base, allowPrivate: true },
    });

  beforeAll(() => {
    const k = crm.kommo;
    k.tokens.add('llt-1');
    k.currency = 'EUR';
    k.pipelines = [
      {
        id: 10,
        name: 'Sales',
        statuses: [
          { id: 100, name: 'Negotiation' },
          { id: 142, name: 'Closed - won' },
          { id: 143, name: 'Closed - lost' },
        ],
      },
    ];
    k.lossReasons = [{ id: 1, name: 'Too expensive' }];
    k.users = [{ id: 7, name: 'Grace Hopper' }];
    k.rows.companies = [
      {
        id: 3,
        name: 'Acme Robotics',
        responsible_user_id: 7,
        custom_fields_values: [{ field_code: 'WEB', values: [{ value: 'acme.test' }] }],
        created_at: 1_756_000_000,
        updated_at: 1_756_700_000,
      },
    ];
    k.rows.contacts = [
      {
        id: 12,
        name: 'Ada Lovelace',
        responsible_user_id: 7,
        custom_fields_values: [
          { field_code: 'EMAIL', values: [{ value: 'ada@acme.test' }] },
          { field_code: 'POSITION', values: [{ value: 'CTO' }] },
        ],
        _embedded: { companies: [{ id: 3 }] },
        created_at: 1_756_000_000,
        updated_at: 1_756_800_000,
      },
    ];
    k.rows.leads = [
      {
        id: 41,
        name: 'Ledger migration',
        price: 40000,
        responsible_user_id: 7,
        status_id: 100,
        pipeline_id: 10,
        created_at: 1_756_000_000,
        updated_at: 1_757_900_000,
        _embedded: { contacts: [{ id: 12, is_main: true }], companies: [{ id: 3 }] },
      },
      {
        id: 42,
        name: 'Lost one',
        price: 100,
        status_id: 143,
        pipeline_id: 10,
        loss_reason_id: 1,
        closed_at: 1_757_950_000,
        updated_at: 1_757_950_000,
      },
      { id: 43, name: 'Deleted', is_deleted: true, updated_at: 1_757_960_000 },
    ];
  });

  afterEach(async () => {
    await c.endRun(ctx());
    crm.calls.length = 0;
  });

  it('lists v4 rows with the updated_at filter and with=contacts; statuses / users / loss reasons / currency resolved; deleted skipped', async () => {
    const deals = await c.list(ctx(), 'deal', { since: null, page: null });
    expect(deals.records.map((r) => r.externalId)).toEqual(['41', '42']);
    expect(deals.records[0]).toMatchObject({
      entityType: 'deal',
      name: 'Ledger migration',
      attributes: {
        amount: 40000,
        currency: 'EUR',
        status: 'open',
        stage: 'Negotiation',
        pipeline: 'Sales',
        owner: 'Grace Hopper',
      },
      relations: [
        { kind: 'primary_contact', targetType: 'person', targetExternalId: '12' },
        { kind: 'organization', targetType: 'organization', targetExternalId: '3' },
      ],
      updatedAt: isoOf(1_757_900_000),
    });
    expect(deals.records[1]?.attributes).toMatchObject({
      status: 'lost',
      stage: 'Closed - lost',
      lost_reason: 'Too expensive',
      lost_at: isoOf(1_757_950_000),
    });
    expect(deals.records[1]?.attributes).not.toHaveProperty('won_at');
    const call = crm.calls.find((x) => x.path.startsWith('/api/v4/leads?'));
    expect(call?.auth).toBe('Bearer llt-1');
    const q = new URL(call!.path, crm.base).searchParams;
    expect(q.get('with')).toBe('contacts');
    expect(q.get('order[updated_at]')).toBe('asc');
    expect(q.get('limit')).toBe('250');

    const persons = await c.list(ctx(), 'person', { since: null, page: null });
    expect(persons.records[0]).toMatchObject({
      name: 'Ada Lovelace',
      attributes: { email: 'ada@acme.test', job_title: 'CTO', owner: 'Grace Hopper' },
      relations: [{ kind: 'works_at', targetType: 'organization', targetExternalId: '3' }],
    });
    const orgs = await c.list(ctx(), 'organization', { since: null, page: null });
    expect(orgs.records[0]?.attributes).toMatchObject({ website: 'acme.test' });
    // Incremental: the filter is epoch seconds; nothing newer → 204 → done.
    const none = await c.list(ctx(), 'organization', {
      since: '2026-09-01T00:00:00.000Z',
      page: null,
    });
    expect(none.records).toHaveLength(0);
    expect(none.next).toBeNull();
    const filtered = crm.calls.filter((x) => x.path.startsWith('/api/v4/companies?')).pop();
    expect(new URL(filtered!.path, crm.base).searchParams.get('filter[updated_at][from]')).toBe(
      String(Math.floor(Date.parse('2026-09-01T00:00:00.000Z') / 1000)),
    );
  });

  it('the whole runtime walks the account and names the targets; baseUrl is required', async () => {
    const walked = await collect(c.enumerate(ctx(), { checkpoint: null, full: true }));
    expect(walked.upserts.map((u) => u.externalId)).toEqual([
      'deal/41',
      'deal/42',
      'person/12',
      'organization/3',
    ]);
    const fetched = (await c.fetch(ctx(), { externalId: 'deal/41' })) as { record: RecordEnvelope };
    expect(fetched.record.relations?.map((r) => r.targetName)).toEqual([
      'Ada Lovelace',
      'Acme Robotics',
    ]);
    expect(await c.get(ctx(), 'deal', '404')).toBeNull();
    const bare = ctxOf({ connector: 'kommo', credential: 'llt-1', config: {} });
    await expect(c.list(bare, 'deal', { since: null, page: null })).rejects.toThrow(
      /config\.baseUrl/,
    );
  });
});
