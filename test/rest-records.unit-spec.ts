/**
 * The long tail on the records contract (W4.2b′):
 *  - the OpenAPI digest: list-shaped GETs and search-shaped POSTs, rows
 *    found under the conventional wrappers, `$ref` + `allOf` resolved,
 *    body parameters of a POST search, YAML as well as JSON;
 *  - the heuristics: collections → the brain's entity types (lookups
 *    skipped), id / name / updated-at by conventional names, paging and
 *    the since-parameter by conventional names (cursor / page / offset /
 *    body), relations from `<entity>_id`, `get` from a sibling `{id}`
 *    path; a sample answer read the same way; the synonym mapping over
 *    the pack vocabulary;
 *  - the `rest_records` connector against the fake API: cursor / page /
 *    link / body-offset paging, the incremental formats, `items` paths,
 *    relations and the deleted flag, `get`, every auth scheme with the
 *    credential masked out of errors, the origin fence;
 *  - the assistant service: heuristics only by default, a sample
 *    refining the document's proposal, the operator's edits kept, the
 *    model pass under the flag with a stubbed client (validated entries
 *    replace, a hallucinated predicate is dropped).
 */
import { ConfigService } from '@nestjs/config';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import type { ConnectorCtx, ItemDelta, RecordEnvelope } from '../src/source-plane/connector';
import {
  RestRecordsConnector,
  resolveUrl,
  valueAt,
} from '../src/source-plane/connectors/rest-records.connector';
import { MappingAssistantService } from '../src/source-plane/records/mapping-assistant.service';
import {
  entityTypeOf,
  proposeFromOperations,
  proposeFromSample,
  proposeMapping,
} from '../src/source-plane/records/mapping-heuristics';
import { digestOpenApi, parseOpenApiText } from '../src/source-plane/records/openapi-digest';
import { vocabularyOf } from '../src/source-plane/records/records-door.service';
import type { RecordsDoorService } from '../src/source-plane/records/records-door.service';
import { startFakeRestApi, type FakeRestApi } from './fixtures/fake-rest-api';

const vocab = vocabularyOf(CRM_MEMORY_PACK);
let api: FakeRestApi;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  api = await startFakeRestApi();
  for (const k of ['SOURCE_EGRESS_ALLOW_PRIVATE', 'SOURCE_MAPPING_ASSISTANT'])
    saved[k] = process.env[k];
  process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
  delete process.env.SOURCE_MAPPING_ASSISTANT;
  api.companies = [
    {
      id: 3,
      name: 'Acme Robotics',
      domain: 'acme.test',
      industry: 'Robotics',
      updated_at: '2026-09-01T10:00:00Z',
    },
    {
      id: 4,
      name: 'Nimbus Foods',
      domain: 'nimbus.test',
      industry: 'Food',
      updated_at: '2026-09-02T10:00:00Z',
    },
    {
      id: 5,
      name: 'Zavod',
      domain: 'zavod.test',
      industry: 'Steel',
      updated_at: '2026-09-03T10:00:00Z',
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
    {
      id: 13,
      first_name: 'Boris',
      last_name: 'Ivanov',
      email: 'b@zavod.test',
      position: 'COO',
      company_id: 5,
      updated_at: '2026-09-04T12:00:00Z',
    },
    {
      id: 14,
      first_name: 'Carla',
      last_name: 'Mendes',
      email: 'c@nimbus.test',
      position: 'CEO',
      company_id: 4,
      updated_at: '2026-09-05T12:00:00Z',
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
    {
      id: 42,
      title: 'Cold chain',
      amount: 25000,
      currency: 'USD',
      stage: 'Proposal',
      status: 'open',
      owner_name: 'Grace Hopper',
      contact_id: 14,
      company_id: 4,
      updated_at: '2026-09-16T10:00:00Z',
      is_deleted: false,
    },
    {
      id: 43,
      title: 'Old one',
      amount: 1,
      currency: 'USD',
      stage: 'Lost',
      status: 'lost',
      updated_at: '2026-09-17T10:00:00Z',
      is_deleted: true,
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
    {
      id: 8,
      subject: 'Invoice typo',
      status: 'closed',
      priority: 'low',
      contact_id: 13,
      updated_at: '2026-09-11T10:00:00Z',
    },
    {
      id: 9,
      subject: 'Feature ask',
      status: 'open',
      priority: 'low',
      contact_id: 14,
      updated_at: '2026-09-12T10:00:00Z',
    },
  ];
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await api.close();
});

function ctxOf(
  config: Record<string, unknown>,
  credential: string | null = 'k-rest-1',
): ConnectorCtx {
  return {
    companyId: 'co',
    connection: {
      id: 'source_connection:rest1',
      packId: 'crm_memory',
      sourceId: 'custom',
      kind: 'native',
      connector: 'rest_records',
      shape: 'structure',
      host: 'server',
      config: {
        baseUrl: `${api.base}/api`,
        allowPrivate: true,
        authScheme: 'header:X-Api-Key',
        ...config,
      },
      credential,
      credentialSource: credential ? 'secret' : null,
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
  const upserts: string[] = [];
  let checkpoint: Record<string, unknown> | null = null;
  for await (const d of it) {
    if (d.type === 'upsert') upserts.push(d.item.externalId);
    else if (d.type === 'checkpoint') checkpoint = d.checkpoint;
  }
  return { upserts, checkpoint };
}

const DEAL_ENDPOINT = {
  list: { path: '/deals' },
  items: 'data',
  get: { path: '/deals/{id}' },
  paging: { style: 'cursor', param: 'cursor', sizeParam: 'limit', size: 2, next: 'next_cursor' },
  incremental: { param: 'updated_since', format: 'iso' },
  fields: { id: 'id', name: ['title'], updatedAt: 'updated_at' },
  relations: [
    { kind: 'primary_contact', targetType: 'person', path: 'contact_id' },
    { kind: 'organization', targetType: 'organization', path: 'company_id' },
  ],
  deleted: 'is_deleted',
};
const PERSON_ENDPOINT = {
  list: { path: '/contacts' },
  items: 'items',
  paging: { style: 'page', param: 'page', sizeParam: 'per_page', size: 2 },
  incremental: { param: 'modified_since', format: 'epoch' },
  fields: { id: 'id', name: ['first_name', 'last_name'], updatedAt: 'updated_at' },
  attributes: { email: 'email', position: 'position' },
  relations: [{ kind: 'works_at', targetType: 'organization', path: 'company_id' }],
};
const ORG_ENDPOINT = {
  list: { path: '/companies' },
  items: 'items',
  paging: { style: 'link', next: 'next' },
  fields: { id: 'id', name: ['name'], updatedAt: 'updated_at' },
};
const TICKET_ENDPOINT = {
  list: { path: '/tickets/search', method: 'POST' },
  items: 'results',
  paging: { style: 'offset', param: 'offset', sizeParam: 'limit', size: 2 },
  incremental: { param: 'since', in: 'body' },
  fields: { id: 'id', name: ['subject'], updatedAt: 'updated_at' },
  relations: [{ kind: 'requester', targetType: 'person', path: 'contact_id' }],
};

describe('openapi digest', () => {
  it('finds the list-shaped reads with their rows, wrappers, params and body params — JSON and YAML alike', async () => {
    const doc = api.openapi();
    const digest = digestOpenApi(doc);
    const byPath = Object.fromEntries(digest.operations.map((o) => [`${o.method} ${o.path}`, o]));
    expect(Object.keys(byPath).sort()).toEqual([
      'GET /companies',
      'GET /contacts',
      'GET /deals',
      'GET /users',
      'POST /tickets/search',
    ]);
    const deals = byPath['GET /deals']!;
    expect(deals.itemsPath).toBe('data');
    expect(deals.answerKeys).toEqual(['data', 'next_cursor']);
    // allOf over a $ref: Base's id / updated_at plus the deal's own.
    expect(deals.properties.map((p) => p.name)).toEqual(
      expect.arrayContaining(['id', 'updated_at', 'title', 'amount', 'contact_id', 'is_deleted']),
    );
    expect(deals.params.map((p) => `${p.in}:${p.name}`)).toEqual([
      'query:updated_since',
      'query:cursor',
      'query:limit',
    ]);
    const tickets = byPath['POST /tickets/search']!;
    expect(tickets.itemsPath).toBe('results');
    expect(tickets.params.map((p) => `${p.in}:${p.name}`)).toEqual([
      'body:offset',
      'body:limit',
      'body:since',
    ]);
    expect(digest.paths).toContain('/deals/{id}');
    expect(digest.servers).toEqual([`${api.base}/api`]);

    const yamlRes = await fetch(`${api.base}/openapi.yaml`);
    const fromYaml = digestOpenApi(parseOpenApiText(await yamlRes.text()));
    expect(fromYaml.operations.map((o) => o.path).sort()).toEqual(
      digest.operations.map((o) => o.path).sort(),
    );
    expect(() => parseOpenApiText('')).toThrow(/empty/);
    expect(() => parseOpenApiText('- just: [a list')).toThrow(/does not parse/);
  });
});

describe('mapping heuristics', () => {
  it('names entities in the brain’s vocabulary and skips lookups', () => {
    expect(entityTypeOf('deals')).toBe('deal');
    expect(entityTypeOf('opportunities')).toBe('deal');
    expect(entityTypeOf('contacts')).toBe('person');
    expect(entityTypeOf('companies')).toBe('organization');
    expect(entityTypeOf('accounts')).toBe('organization');
    expect(entityTypeOf('categories')).toBe('category');
    expect(entityTypeOf('invoices')).toBe('invoice');
    expect(entityTypeOf('users')).toBeNull();
    expect(entityTypeOf('stages')).toBeNull();
  });

  it('proposes endpoints from the digest: fields, paging, since-parameter, relations, get; the sample reads the same', () => {
    const proposals = proposeFromOperations(digestOpenApi(api.openapi()));
    const by = Object.fromEntries(proposals.map((p) => [p.type, p]));
    expect(Object.keys(by).sort()).toEqual(['deal', 'organization', 'person', 'ticket']);
    expect(by.deal!.endpoint).toMatchObject({
      list: { path: '/deals' },
      items: 'data',
      get: { path: '/deals/{id}' },
      paging: { style: 'cursor', param: 'cursor', sizeParam: 'limit', next: 'next_cursor' },
      incremental: { param: 'updated_since', format: 'iso' },
      fields: { id: 'id', name: ['title'], updatedAt: 'updated_at' },
      deleted: 'is_deleted',
    });
    expect(by.deal!.endpoint.relations).toEqual([
      { kind: 'primary_contact', targetType: 'person', path: 'contact_id' },
      { kind: 'organization', targetType: 'organization', path: 'company_id' },
    ]);
    expect(by.deal!.attributeKeys).toEqual([
      'amount',
      'currency',
      'stage',
      'status',
      'owner_name',
      'expected_close',
    ]);
    expect(by.deal!.confidence).toBeGreaterThan(0.8);
    expect(by.person!.endpoint).toMatchObject({
      paging: { style: 'page', param: 'page', sizeParam: 'per_page' },
      incremental: { param: 'modified_since', format: 'epoch' },
      fields: { id: 'id', name: ['first_name', 'last_name'] },
    });
    expect(by.person!.endpoint.get).toBeUndefined();
    expect(by.ticket!.endpoint).toMatchObject({
      list: { path: '/tickets/search', method: 'POST' },
      items: 'results',
      paging: { style: 'offset', param: 'offset', sizeParam: 'limit' },
      incremental: { param: 'since', format: 'iso', in: 'body' },
    });
    expect(by.organization!.endpoint.paging).toMatchObject({
      style: 'cursor',
      param: 'after',
      next: 'next',
    });

    const sample = proposeFromSample({
      path: '/companies',
      json: { items: api.companies, next: `${api.base}/api/companies?after=2` },
    })!;
    expect(sample.type).toBe('organization');
    expect(sample.source).toBe('sample');
    expect(sample.endpoint).toMatchObject({
      items: 'items',
      paging: { style: 'link', next: 'next' },
      fields: { id: 'id', name: ['name'], updatedAt: 'updated_at' },
    });
    expect(sample.attributeKeys).toEqual(['domain', 'industry']);
    expect(proposeFromSample({ json: { total: 0 } })).toBeNull();
  });

  it('maps attribute keys to the pack vocabulary by synonym, one key per predicate, party vs deal aware', () => {
    const deal = proposeMapping(
      'deal',
      ['amount', 'currency', 'stage', 'status', 'owner_name', 'expected_close', 'notes'],
      vocab,
    );
    expect(deal).toEqual({
      fields: {
        amount: 'deal_amount',
        currency: 'currency',
        stage: 'deal_stage',
        status: 'deal_status',
        owner_name: 'owner',
        expected_close: 'expected_close',
      },
      coreType: 'project',
    });
    const person = proposeMapping('person', ['email', 'position', 'status', 'title'], vocab);
    expect(person).toEqual({
      fields: { position: 'job_title', status: 'lifecycle_stage' },
      coreType: 'customer',
    });
    expect(proposeMapping('organization', ['domain', 'industry', 'amount'], vocab).fields).toEqual({
      domain: 'website',
      industry: 'industry',
    });
  });
});

describe('rest_records connector', () => {
  const c = new RestRecordsConnector();
  const endpoints = {
    deal: DEAL_ENDPOINT,
    person: PERSON_ENDPOINT,
    organization: ORG_ENDPOINT,
    ticket: TICKET_ENDPOINT,
  };
  afterEach(async () => {
    api.auth = 'header';
    api.calls.length = 0;
    await c.endRun(ctxOf({ endpoints }));
  });

  it('walks every paging style, honours the since formats, reads the rows by path', async () => {
    const ctx = ctxOf({ endpoints });
    const walked = await collect(c.enumerate(ctx, { checkpoint: null, full: true }));
    expect(walked.upserts).toEqual([
      'deal/41',
      'deal/42',
      'person/12',
      'person/13',
      'person/14',
      'organization/3',
      'organization/4',
      'organization/5',
      'ticket/7',
      'ticket/8',
      'ticket/9',
    ]);
    // Cursor, page, link, body-offset: each walked more than one page.
    const paths = api.calls.map((x) => `${x.method} ${x.path}`);
    expect(paths.filter((p) => p.startsWith('GET /api/deals?')).length).toBe(2);
    expect(paths.filter((p) => p.startsWith('GET /api/contacts?')).length).toBe(2);
    expect(paths.filter((p) => p.startsWith('GET /api/companies'))).toEqual([
      'GET /api/companies',
      'GET /api/companies?after=2',
    ]);
    expect(paths.filter((p) => p === 'POST /api/tickets/search').length).toBe(2);
    const bodies = api.calls
      .filter((x) => x.path === '/api/tickets/search')
      .map((x) => JSON.parse(x.body));
    expect(bodies).toEqual([
      { limit: 2, offset: 0 },
      { limit: 2, offset: 2 },
    ]);
    expect(
      api.calls
        .filter((x) => x.path.startsWith('/api/'))
        .every((x) => x.headers['x-api-key'] === 'k-rest-1'),
    ).toBe(true);

    const fetched = (await c.fetch(ctx, { externalId: 'deal/41' })) as { record: RecordEnvelope };
    expect(fetched.record).toMatchObject({
      entityType: 'deal',
      name: 'Ledger migration',
      attributes: {
        amount: 40000,
        currency: 'EUR',
        stage: 'Negotiation',
        status: 'open',
        owner_name: 'Grace Hopper',
        expected_close: '2026-10-31',
      },
      updatedAt: '2026-09-15T10:00:00.000Z',
    });
    expect(fetched.record.relations?.map((r) => [r.kind, r.targetName])).toEqual([
      ['primary_contact', 'Ada Lovelace'],
      ['organization', 'Acme Robotics'],
    ]);
    // The deleted flag skipped deal 43; picked attributes on persons; every scalar on organizations.
    expect(fetched.record.attributes).not.toHaveProperty('is_deleted');
    const person = (await c.fetch(ctx, { externalId: 'person/12' })) as { record: RecordEnvelope };
    expect(person.record.attributes).toEqual({ email: 'ada@acme.test', position: 'CTO' });
    const org = (await c.fetch(ctx, { externalId: 'organization/3' })) as {
      record: RecordEnvelope;
    };
    expect(org.record.attributes).toEqual({ domain: 'acme.test', industry: 'Robotics' });

    // Incremental: the since value in each endpoint's format, in the query or the body.
    api.calls.length = 0;
    await c.endRun(ctx);
    const since = {
      deal: { since: '2026-09-16T00:00:00.000Z' },
      person: { since: '2026-09-05T00:00:00.000Z' },
      ticket: { since: '2026-09-11T00:00:00.000Z' },
    };
    const again = await collect(
      c.enumerate(ctxOf({ endpoints, overlapMinutes: 0 }), {
        checkpoint: { entities: since },
        full: false,
      }),
    );
    expect(again.upserts).toEqual([
      'deal/42',
      'person/14',
      'organization/3',
      'organization/4',
      'organization/5',
      'ticket/8',
      'ticket/9',
    ]);
    const dealCall = new URL(
      api.calls.find((x) => x.path.startsWith('/api/deals?'))!.path,
      api.base,
    );
    expect(dealCall.searchParams.get('updated_since')).toBe('2026-09-16T00:00:00.000Z');
    const contactCall = new URL(
      api.calls.find((x) => x.path.startsWith('/api/contacts?'))!.path,
      api.base,
    );
    expect(contactCall.searchParams.get('modified_since')).toBe(
      String(Date.parse('2026-09-05T00:00:00.000Z') / 1000),
    );
    const ticketCall = api.calls.find((x) => x.path === '/api/tickets/search')!;
    expect(JSON.parse(ticketCall.body)).toMatchObject({
      since: '2026-09-11T00:00:00.000Z',
      offset: 0,
    });
  });

  it('get reads one record by id (unwrapped by the id field); missing is null; no get path is null', async () => {
    const ctx = ctxOf({ endpoints });
    expect(await c.get(ctx, 'deal', '42')).toMatchObject({ name: 'Cold chain' });
    expect(await c.get(ctx, 'deal', '999')).toBeNull();
    expect(await c.get(ctx, 'person', '12')).toBeNull();
  });

  it('every auth scheme rides as configured and the credential never appears in an error; the origin is fenced', async () => {
    api.auth = 'query';
    const q = ctxOf({ endpoints, authScheme: 'query:api_key' });
    const page = await c.list(q, 'organization', { since: null, page: null });
    expect(page.records).toHaveLength(2);
    expect(api.calls.at(-1)!.path).toContain('api_key=k-rest-1');
    let msg = '';
    try {
      await c.list(
        ctxOf({ endpoints, authScheme: 'query:api_key' }, 'wrong-secret'),
        'organization',
        { since: null, page: null },
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/401/);
    expect(msg).not.toContain('wrong-secret');

    api.auth = 'bearer';
    await c.list(ctxOf({ endpoints, authScheme: 'bearer' }), 'organization', {
      since: null,
      page: null,
    });
    expect(api.calls.at(-1)!.headers.authorization).toBe('Bearer k-rest-1');
    api.auth = 'header';
    await c
      .list(ctxOf({ endpoints, authScheme: 'basic' }, 'u:p'), 'organization', {
        since: null,
        page: null,
      })
      .catch(() => undefined);
    expect(api.calls.at(-1)!.headers.authorization).toBe(
      `Basic ${Buffer.from('u:p').toString('base64')}`,
    );

    expect(resolveUrl(`${api.base}/api`, '/deals')).toBe(`${api.base}/api/deals`);
    expect(resolveUrl(`${api.base}/api/`, 'deals?x=1')).toBe(`${api.base}/api/deals?x=1`);
    expect(() => resolveUrl(`${api.base}/api`, 'https://evil.example/deals')).toThrow(
      /not the connection's origin/,
    );
    await expect(
      c.list(
        ctxOf({
          endpoints: { deal: { ...DEAL_ENDPOINT, list: { path: 'https://evil.example/x' } } },
        }),
        'deal',
        { since: null, page: null },
      ),
    ).rejects.toThrow(/origin/);
    await expect(
      c.list(ctxOf({ endpoints: {} }), 'deal', { since: null, page: null }),
    ).rejects.toThrow(/no endpoint configured/);
    await expect(
      c.list(ctxOf({ baseUrl: 'nope', endpoints }), 'deal', { since: null, page: null }),
    ).rejects.toThrow(/config baseUrl/);
    expect(valueAt({ a: [{ b: 1 }] }, 'a.0.b')).toBe(1);
    expect(valueAt({ a: [{ b: 1 }] }, 'a.1.b')).toBeUndefined();
  });

  it('the entities and the mapping come from the config; the preview sees them as any vendor’s', () => {
    const cfg = { endpoints, entities: ['deal', 'ticket'] };
    expect(c.entitiesFor(cfg).map((e) => e.type)).toEqual([
      'deal',
      'person',
      'organization',
      'ticket',
    ]);
    expect(c.selectedEntities(cfg).map((e) => e.type)).toEqual(['deal', 'ticket']);
    expect(
      c
        .entitiesFor(cfg)
        .find((e) => e.type === 'person')!
        .fields.map((f) => f.key),
    ).toEqual(['email', 'position']);
  });
});

describe('mapping assistant service', () => {
  const door = { vocabularyFor: async () => vocab } as unknown as RecordsDoorService;
  const config = new ConfigService({ OPENAI_API_KEY: 'sk-stub' });
  const svc = () => new MappingAssistantService(door, config);

  it('proposes from a fetched document, a sample refines the same entity, the operator’s edits win; no model without the flag', async () => {
    const res = await svc().assist('co', {
      packId: 'crm_memory',
      openapi: { url: `${api.base}/openapi.json` },
      samples: [
        {
          path: '/companies',
          json: { items: api.companies, next: `${api.base}/api/companies?after=2` },
        },
      ],
      endpoints: { ticket: { ...TICKET_ENDPOINT, label: 'Support tickets' } as never },
      allowPrivate: true,
    });
    expect(res.refined).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(Object.keys(res.endpoints).sort()).toEqual(['deal', 'organization', 'person', 'ticket']);
    const rows = Object.fromEntries(res.entities.map((e) => [e.type, e]));
    expect(rows.ticket).toMatchObject({
      source: 'operator',
      confidence: 1,
      label: 'Support tickets',
    });
    expect(rows.organization!.source).toBe('openapi');
    expect(rows.organization!.reason).toContain('the sample confirmed the rows');
    // The sample saw the real answer: `next` is a link, not a cursor.
    expect(res.endpoints.organization!.paging).toEqual({ style: 'link', next: 'next' });
    expect(res.mapping.deal!.fields).toMatchObject({ amount: 'deal_amount', stage: 'deal_stage' });
    expect(res.mapping.organization!.fields).toEqual({ domain: 'website', industry: 'industry' });
    expect(rows.deal!.fields.map((f) => f.key)).toContain('owner_name');

    await expect(svc().assist('co', { packId: 'crm_memory' })).rejects.toThrow(
      /OpenAPI document|sample/,
    );
    const pasted = await svc().assist('co', {
      packId: 'crm_memory',
      openapi: { text: JSON.stringify({ openapi: '3.0.0', paths: {} }) },
    });
    expect(pasted.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no list-shaped read operation/),
        expect.stringMatching(/nothing to propose/),
      ]),
    );
  });

  it('under the flag the model refines: validated entries replace the heuristic, a hallucinated predicate is dropped, a failure is a warning', async () => {
    process.env.SOURCE_MAPPING_ASSISTANT = '1';
    try {
      const s = svc();
      const answer = {
        entities: [
          {
            type: 'deal',
            label: 'Deals',
            list: { path: '/deals', method: null },
            items: 'data',
            get: '/deals/{id}',
            paging: {
              style: 'cursor',
              param: 'cursor',
              sizeParam: 'limit',
              size: 100,
              next: 'next_cursor',
            },
            incremental: { param: 'updated_since', format: 'iso', in: null },
            fields: { id: 'id', name: ['title'], updatedAt: 'updated_at' },
            relations: [
              { kind: 'organization', targetType: 'organization', path: 'company_id', name: null },
            ],
            deleted: 'is_deleted',
            mapping: [
              { field: 'amount', predicate: 'deal_amount' },
              { field: 'stage', predicate: 'deal_stage' },
              { field: 'owner_name', predicate: 'made_up_predicate' },
              { field: 'not_a_field', predicate: 'currency' },
            ],
            confidence: 0.9,
            reason: 'the deals list with a cursor',
          },
          {
            type: 'BAD TYPE',
            label: null,
            list: { path: '/x', method: null },
            items: null,
            get: null,
            paging: null,
            incremental: null,
            fields: { id: 'id', name: ['n'], updatedAt: null },
            relations: [],
            deleted: null,
            mapping: [],
            confidence: 0.1,
            reason: 'no',
          },
        ],
      };
      const calls: unknown[] = [];
      (s as unknown as { openai: unknown }).openai = {
        chat: {
          completions: {
            create: async (req: unknown) => {
              calls.push(req);
              return { choices: [{ message: { content: JSON.stringify(answer) } }] };
            },
          },
        },
      };
      const res = await s.assist('co', {
        packId: 'crm_memory',
        openapi: { text: JSON.stringify(api.openapi()) },
      });
      expect(res.refined).toBe(true);
      expect(calls).toHaveLength(1);
      const req = calls[0] as {
        response_format: { json_schema: { strict: boolean } };
        messages: Array<{ content: string }>;
      };
      expect(req.response_format.json_schema.strict).toBe(true);
      expect(req.messages[1]!.content).toContain('heuristicProposal');
      expect(res.endpoints.deal!.relations).toEqual([
        { kind: 'organization', targetType: 'organization', path: 'company_id' },
      ]);
      expect(res.endpoints.deal!.paging).toMatchObject({ size: 100 });
      expect(res.mapping.deal!.fields).toEqual({ amount: 'deal_amount', stage: 'deal_stage' });
      expect(res.entities.find((e) => e.type === 'deal')).toMatchObject({
        confidence: 0.9,
        reason: 'the deals list with a cursor',
      });
      expect(res.endpoints).not.toHaveProperty('BAD TYPE');
      // The other entities kept their heuristic proposals.
      expect(res.endpoints.person!.paging).toMatchObject({ style: 'page' });

      (s as unknown as { openai: unknown }).openai = {
        chat: {
          completions: {
            create: async () => {
              throw new Error('rate limited');
            },
          },
        },
      };
      const failed = await s.assist('co', {
        packId: 'crm_memory',
        openapi: { text: JSON.stringify(api.openapi()) },
      });
      expect(failed.refined).toBe(false);
      expect(failed.warnings).toEqual([expect.stringMatching(/did not answer \(rate limited\)/)]);
      expect(failed.endpoints.deal!.paging).toMatchObject({ style: 'cursor' });
    } finally {
      delete process.env.SOURCE_MAPPING_ASSISTANT;
    }
  });
});
