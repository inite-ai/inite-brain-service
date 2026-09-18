/**
 * The `salesforce` connector against the fake org (W4.2c): SOQL
 * building, the envelope from nested and flat rows, the JWT bearer
 * assertion (verified by the fake under the test's public key), the
 * walk with `nextRecordsUrl` pages and the deleted-ids feed, one record
 * by id, and the Bulk API 2.0 first walk with CSV pages.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { ConnectorCtx, ItemDelta } from '../src/source-plane/connector';
import {
  SalesforceConnector,
  soqlOf,
  soqlDatetime,
  toEnvelope,
} from '../src/source-plane/connectors/salesforce.connector';
import { mintAssertion, parseJwtCredential } from '../src/source-plane/connectors/salesforce-auth';
import { parseCsv } from '../src/source-plane/connectors/salesforce-bulk';
import { startFakeSalesforce, type FakeSalesforce } from './fixtures/fake-salesforce';

const ENV = [
  'SOURCE_OAUTH_SALESFORCE_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'SOURCE_KIND_SALESFORCE',
];

describe('salesforce connector', () => {
  let sf: FakeSalesforce;
  const saved: Record<string, string | undefined> = {};
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  beforeAll(async () => {
    sf = await startFakeSalesforce();
    sf.jwt.publicKey = publicKey;
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SOURCE_OAUTH_SALESFORCE_BASE_URL = sf.base;
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    process.env.SOURCE_KIND_SALESFORCE = '1';
  });
  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await sf.close();
  });
  beforeEach(() => {
    sf.calls.length = 0;
    sf.objects = {
      Opportunity: [
        {
          Id: '006A',
          Name: 'Ledger migration',
          Amount: 40000,
          StageName: 'Negotiation',
          CloseDate: '2026-10-31',
          IsClosed: false,
          IsWon: false,
          Probability: 60,
          LeadSource: 'Web',
          NextStep: 'Legal review',
          OwnerId: '005A',
          Owner: { attributes: { type: 'User' }, Name: 'Grace Hopper' },
          AccountId: '001A',
          Account: { attributes: { type: 'Account' }, Name: 'Acme Robotics' },
          ContactId: '003A',
          CreatedDate: '2026-09-01T10:00:00.000+0000',
          LastModifiedDate: '2026-09-15T10:00:00.000+0000',
        },
        {
          Id: '006B',
          Name: 'Support renewal',
          Amount: 1200.5,
          StageName: 'Closed Won',
          CloseDate: '2026-09-10',
          IsClosed: true,
          IsWon: true,
          OwnerId: '005A',
          Owner: { Name: 'Grace Hopper' },
          LastModifiedDate: '2026-09-16T10:00:00.000+0000',
        },
        {
          Id: '006C',
          Name: 'Old pilot',
          StageName: 'Closed Lost',
          IsClosed: true,
          IsWon: false,
          LastModifiedDate: '2026-09-17T10:00:00.000+0000',
        },
      ],
      Contact: [
        {
          Id: '003A',
          Name: 'Ada Lovelace',
          Email: 'ada@acme.test',
          Title: 'CTO',
          AccountId: '001A',
          Account: { Name: 'Acme Robotics' },
          Owner: { Name: 'Grace Hopper' },
          LastModifiedDate: '2026-09-02T12:00:00.000+0000',
        },
      ],
      Account: [
        {
          Id: '001A',
          Name: 'Acme Robotics',
          Website: 'acme.test',
          Industry: 'Robotics',
          NumberOfEmployees: 120,
          Owner: { Name: 'Grace Hopper' },
          LastModifiedDate: '2026-09-01T10:00:00.000+0000',
        },
      ],
    };
    sf.deleted = {};
  });

  const ctxOf = (
    credential: string,
    source: 'grant' | 'secret',
    config: Record<string, unknown> = {},
  ): ConnectorCtx => ({
    companyId: 'co_test',
    connection: {
      id: 'source_connection:sfunit',
      packId: 'crm_memory',
      sourceId: 'salesforce',
      kind: 'native',
      connector: 'salesforce',
      shape: 'structure',
      host: 'server',
      config,
      credential,
      credentialSource: source,
      contentPolicy: 'text',
      vertical: 'crm',
      recorder: 'r',
      userId: null,
      grant:
        source === 'grant' ? { account: 'owner@acme.test', apiBase: 'https://acme.example' } : null,
    },
    signal: new AbortController().signal,
    log: () => undefined,
  });

  const jwtCredential = () =>
    JSON.stringify({ clientId: sf.jwt.clientId, username: sf.jwt.username, privateKey });

  it('builds SOQL with a seconds-precision datetime literal and an ascending order', () => {
    const spec = { object: 'Opportunity', fields: ['Id', 'Name', 'Owner.Name'] };
    expect(soqlOf(spec, null)).toBe(
      'SELECT Id, Name, Owner.Name FROM Opportunity ORDER BY LastModifiedDate ASC',
    );
    expect(soqlOf(spec, '2026-09-15T10:00:00.123Z')).toBe(
      'SELECT Id, Name, Owner.Name FROM Opportunity WHERE LastModifiedDate > 2026-09-15T10:00:00Z ORDER BY LastModifiedDate ASC',
    );
    expect(soqlDatetime('2026-09-15T12:00:00+02:00')).toBe('2026-09-15T10:00:00Z');
    expect(() => soqlDatetime('yesterday')).toThrow(/not a timestamp/);
  });

  it('turns a query row (nested) and a bulk CSV row (flat) into the same envelope', () => {
    const nested = toEnvelope('deal', sf.objects.Opportunity![0]!)!;
    expect(nested).toMatchObject({
      entityType: 'deal',
      externalId: '006A',
      name: 'Ledger migration',
      updatedAt: '2026-09-15T10:00:00.000Z',
      attributes: {
        amount: 40000,
        stage: 'Negotiation',
        status: 'open',
        probability: 60,
        expected_close: '2026-10-31',
        lead_source: 'Web',
        next_step: 'Legal review',
        owner: 'Grace Hopper',
        created_at: '2026-09-01T10:00:00.000Z',
      },
    });
    expect(nested.relations).toEqual([
      { kind: 'primary_contact', targetType: 'person', targetExternalId: '003A' },
      {
        kind: 'organization',
        targetType: 'organization',
        targetExternalId: '001A',
        targetName: 'Acme Robotics',
      },
    ]);
    const flat = toEnvelope('deal', {
      Id: '006A',
      Name: 'Ledger migration',
      Amount: '40000',
      StageName: 'Negotiation',
      IsClosed: 'false',
      IsWon: 'false',
      Probability: '60',
      'Owner.Name': 'Grace Hopper',
      AccountId: '001A',
      'Account.Name': 'Acme Robotics',
      ContactId: '003A',
      LastModifiedDate: '2026-09-15T10:00:00.000Z',
    })!;
    expect(flat.attributes).toMatchObject({
      amount: 40000,
      probability: 60,
      status: 'open',
      owner: 'Grace Hopper',
    });
    expect(flat.relations).toEqual(nested.relations);
    expect(toEnvelope('deal', sf.objects.Opportunity![1]!)!.attributes.status).toBe('won');
    expect(toEnvelope('deal', sf.objects.Opportunity![2]!)!.attributes.status).toBe('lost');
    expect(toEnvelope('person', sf.objects.Contact![0]!)).toMatchObject({
      name: 'Ada Lovelace',
      attributes: { email: 'ada@acme.test', job_title: 'CTO', owner: 'Grace Hopper' },
      relations: [
        {
          kind: 'works_at',
          targetType: 'organization',
          targetExternalId: '001A',
          targetName: 'Acme Robotics',
        },
      ],
    });
    expect(toEnvelope('ticket', { Id: '500A', CaseNumber: '00001', Status: 'New' })).toMatchObject({
      name: 'Case 00001',
    });
    expect(toEnvelope('deal', { Name: 'no id' })).toBeNull();
    expect(toEnvelope('unknown', { Id: 'x' })).toBeNull();
  });

  it('parses RFC 4180 CSV — quoted commas, doubled quotes, newlines in a field, CRLF', () => {
    const rows = parseCsv(
      'Id,Name,"Owner.Name"\r\n"1","Ledger, migration","Grace ""Amazing"" Hopper"\r\n2,"two\nlines",\r\n',
    );
    expect(rows).toEqual([
      { Id: '1', Name: 'Ledger, migration', 'Owner.Name': 'Grace "Amazing" Hopper' },
      { Id: '2', Name: 'two\nlines', 'Owner.Name': '' },
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('Id\n')).toEqual([]);
  });

  it('mints an RS256 assertion the org verifies, and names what a JWT credential lacks', () => {
    const jwt = parseJwtCredential(jwtCredential());
    const assertion = mintAssertion(jwt, 'https://login.salesforce.com', 1_758_000_000_000);
    const [h, c] = assertion.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toEqual({
      iss: sf.jwt.clientId,
      sub: sf.jwt.username,
      aud: 'https://login.salesforce.com',
      exp: 1_758_000_000 + 180,
    });
    expect(() => parseJwtCredential('not json')).toThrow(
      /neither a connected account nor a JWT bearer/,
    );
    expect(() => parseJwtCredential(JSON.stringify({ clientId: 'x', username: 'y' }))).toThrow(
      /lacks "privateKey"/,
    );
    expect(() =>
      parseJwtCredential(JSON.stringify({ clientId: 'x', username: 'y', privateKey: 'nope' })),
    ).toThrow(/PEM/);
  });

  it('walks each entity by pages as a JWT bearer (one exchange per run), names owners and accounts, closes what the deleted feed names on the incremental walk', async () => {
    const connector = new SalesforceConnector();
    const ctx = ctxOf(jwtCredential(), 'secret');
    const deltas: ItemDelta[] = [];
    for await (const d of connector.enumerate(ctx, { checkpoint: null, full: true }))
      deltas.push(d);
    const upserts = deltas.filter((d) => d.type === 'upsert');
    expect(upserts.map((d) => (d as { item: { externalId: string } }).item.externalId)).toEqual([
      'deal/006A',
      'deal/006B',
      'deal/006C',
      'person/003A',
      'organization/001A',
    ]);
    const exchanges = sf.calls.filter((c) => c.path === '/services/oauth2/token');
    expect(exchanges).toHaveLength(1);
    expect(new URLSearchParams(exchanges[0]!.body).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    // Three opportunities at two a page = the first query and one locator page.
    expect(sf.calls.filter((c) => c.path.includes('/query?q=')).length).toBe(3);
    expect(sf.calls.filter((c) => /\/query\/01g/.test(c.path)).length).toBe(1);
    expect(sf.calls.some((c) => c.path.includes('/deleted/'))).toBe(false);
    const fetched = await connector.fetch(ctx, { externalId: 'deal/006A' });
    expect(fetched.shape).toBe('structure');
    if (fetched.shape !== 'structure') throw new Error('shape');
    expect(fetched.record.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'primary_contact', targetName: 'Ada Lovelace' }),
        expect.objectContaining({ kind: 'organization', targetName: 'Acme Robotics' }),
      ]),
    );
    expect(fetched.mapping?.fields.amount).toBe('deal_amount');
    const checkpoint = deltas.find((d) => d.type === 'checkpoint') as {
      checkpoint: Record<string, unknown>;
    };
    await connector.endRun(ctx);

    // Incremental: nothing new, one opportunity deleted since the checkpoint.
    sf.calls.length = 0;
    sf.deleted = { Opportunity: [{ id: '006C', deletedDate: new Date().toISOString() }] };
    const again: ItemDelta[] = [];
    for await (const d of connector.enumerate(ctx, {
      checkpoint: checkpoint.checkpoint,
      full: false,
    }))
      again.push(d);
    expect(again.filter((d) => d.type === 'upsert')).toHaveLength(0);
    expect(again.filter((d) => d.type === 'gone')).toEqual([
      { type: 'gone', externalId: 'deal/006C' },
    ]);
    const q = sf.calls.find((c) => c.path.includes('/query?q='))!;
    // `+` for spaces is the documented query form (`q=SELECT+Id+FROM+Account`).
    expect(decodeURIComponent(q.path).replace(/\+/g, ' ')).toMatch(
      /WHERE LastModifiedDate > 2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z ORDER BY/,
    );
    expect(sf.calls.filter((c) => c.path.includes('/deleted/')).length).toBe(3);
    await connector.endRun(ctx);
  });

  it('runs as a connected account against the org the grant named, and a 404 on get is "gone"', async () => {
    const connector = new SalesforceConnector();
    sf.tokens.add('grant-token');
    const ctx = ctxOf('grant-token', 'grant');
    expect(await connector.get(ctx, 'person', '003A')).toMatchObject({ name: 'Ada Lovelace' });
    expect(await connector.get(ctx, 'person', 'nope')).toBeNull();
    expect(sf.calls.some((c) => c.path === '/services/oauth2/token')).toBe(false);
    expect(sf.calls[0]!.auth).toBe('Bearer grant-token');
    await connector.endRun(ctx);
  });

  it('refuses a connected account whose grant named no org', async () => {
    const connector = new SalesforceConnector();
    sf.tokens.add('grant-token-2');
    process.env.SOURCE_OAUTH_SALESFORCE_BASE_URL = '';
    const ctx = ctxOf('grant-token-2', 'grant');
    ctx.connection.grant = { account: 'x', apiBase: null };
    await expect(connector.list(ctx, 'deal', { since: null, page: null })).rejects.toThrow(
      /named no org/,
    );
    process.env.SOURCE_OAUTH_SALESFORCE_BASE_URL = sf.base;
    await connector.endRun(ctx);
  });

  it('takes the first walk through Bulk API 2.0 when asked — one job per object, CSV pages by locator — and the incremental walk through the query endpoint', async () => {
    const connector = new SalesforceConnector();
    sf.bulkPolls = 2;
    sf.bulkPageSize = 2;
    const ctx = ctxOf(jwtCredential(), 'secret', { bulk: true, entities: ['deal'] });
    const deltas: ItemDelta[] = [];
    for await (const d of connector.enumerate(ctx, { checkpoint: null, full: true }))
      deltas.push(d);
    const ids = deltas
      .filter((d) => d.type === 'upsert')
      .map((d) => (d as { item: { externalId: string } }).item.externalId);
    expect(ids).toEqual(['deal/006A', 'deal/006B', 'deal/006C']);
    expect(
      sf.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/jobs/query')).length,
    ).toBe(1);
    expect(sf.calls.filter((c) => /\/jobs\/query\/[^/]+$/.test(c.path)).length).toBe(2);
    expect(sf.calls.filter((c) => c.path.includes('/results')).length).toBe(2);
    expect(sf.calls.some((c) => c.path.includes('/query?q='))).toBe(false);
    const fetched = await connector.fetch(ctx, { externalId: 'deal/006B' });
    if (fetched.shape !== 'structure') throw new Error('shape');
    expect(fetched.record.attributes).toMatchObject({
      amount: 1200.5,
      status: 'won',
      owner: 'Grace Hopper',
    });
    const checkpoint = deltas.find((d) => d.type === 'checkpoint') as {
      checkpoint: Record<string, unknown>;
    };
    await connector.endRun(ctx);
    sf.calls.length = 0;
    const again: ItemDelta[] = [];
    for await (const d of connector.enumerate(ctx, {
      checkpoint: checkpoint.checkpoint,
      full: false,
    }))
      again.push(d);
    expect(sf.calls.some((c) => c.path.endsWith('/jobs/query'))).toBe(false);
    expect(sf.calls.some((c) => c.path.includes('/query?q='))).toBe(true);
    await connector.endRun(ctx);
  });
});
