/**
 * Salesforce end to end on a REAL SurrealDB (W4.2c): a connected account
 * whose grant learned the org (`instance_url`) at the token endpoint and
 * its label from the identity URL the token named; a sync that walks
 * opportunities / contacts / accounts into facts with owner and account
 * edges; an incremental run that closes what the deleted-ids feed
 * names; a JWT bearer preview for an integration user; the catalogue
 * entry (no webhook lane — Salesforce CDC waits for demand).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeSalesforce, type FakeSalesforce } from './fixtures/fake-salesforce';

const COMPANY = 'co_salesforce_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_SALESFORCE',
  'SOURCE_OAUTH_SALESFORCE_CLIENT_ID',
  'SOURCE_OAUTH_SALESFORCE_CLIENT_SECRET',
  'SOURCE_OAUTH_SALESFORCE_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('salesforce (e2e)', () => {
  let f: AppFixture;
  let sf: FakeSalesforce;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  beforeAll(async () => {
    sf = await startFakeSalesforce();
    sf.jwt.publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_SALESFORCE: '1',
      SOURCE_OAUTH_SALESFORCE_CLIENT_ID: 'sf-client',
      SOURCE_OAUTH_SALESFORCE_CLIENT_SECRET: 'sf-secret',
      SOURCE_OAUTH_SALESFORCE_BASE_URL: sf.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seed(sf);
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
    await sf.close();
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
  const sync = (id: string) =>
    f.http.post(`/v1/admin/source-connections/${id}/sync`).set(auth()).send({ inline: true });

  it('the catalogue lists salesforce as a connected-account source without a webhook lane, hubspot with one', async () => {
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    const entry = catalog.body.sources.find(
      (s: { sourceId: string }) => s.sourceId === 'salesforce',
    );
    expect(entry).toMatchObject({
      connector: 'salesforce',
      availability: 'ready',
      oauth: { provider: 'salesforce', configured: true, scopes: ['api'] },
      webhook: null,
    });
    expect(entry.records.entities.map((e: { type: string }) => e.type)).toEqual([
      'deal',
      'person',
      'organization',
      'lead',
      'ticket',
    ]);
    // HubSpot's kind is off in this app: a disabled connector shows no lane at all, like its oauth.
    const hubspot = catalog.body.sources.find(
      (s: { sourceId: string }) => s.sourceId === 'hubspot',
    );
    expect(hubspot).toMatchObject({ availability: 'disabled', webhook: null, oauth: null });
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const provider = grants.body.providers.find((p: { id: string }) => p.id === 'salesforce');
    expect(provider).toMatchObject({ title: 'Salesforce', configured: true });
  });

  it('connected account: the grant learns the org and the label from the token answer; a sync walks the org; a deletion closes on the next run', async () => {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'salesforce', connector: 'salesforce' });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.origin).toBe(sf.base);
    expect(authorize.pathname).toBe('/services/oauth2/authorize');
    expect(authorize.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'api',
      'openid',
      'refresh_token',
    ]);
    const state = authorize.searchParams.get('state')!;
    sf.codes.add('sf-code-1');
    const cb = await f.http.get(
      `/v1/source-connections/oauth/callback?state=${encodeURIComponent(state)}&code=sf-code-1`,
    );
    expect(cb.text).toContain('Connected');
    // The identity came from the token's own `id` URL, not the userinfo endpoint.
    expect(sf.calls.some((c) => c.path.startsWith(`/id/${sf.identity.orgId}/`))).toBe(true);
    expect(sf.calls.some((c) => c.path === '/services/oauth2/userinfo')).toBe(false);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find((g: { provider: string }) => g.provider === 'salesforce');
    expect(grant.account).toBe('owner@acme.test');
    expect(grant.apiBase).toBe(sf.base);
    expect(grant.refreshable).toBe(true);

    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'salesforce',
        vertical: 'crm',
        label: 'Salesforce',
        config: {},
        credential: `oauth:${grant.id}`,
      });
    expect(conn.status).toBe(201);
    expect(conn.body.grantId).toBe(grant.id);
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'full',
      seen: 4,
      ingested: 4,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(
      expect.arrayContaining(['Negotiation', 'Closed Won']),
    );
    expect(await factsOf('crm_memory__deal_status')).toEqual(
      expect.arrayContaining(['open', 'won']),
    );
    expect(await factsOf('crm_memory__deal_amount')).toContain('40000');
    expect(await factsOf('crm_memory__owner')).toContain('Grace Hopper');
    expect(await factsOf('crm_memory__job_title')).toEqual(['CTO']);
    expect(await factsOf('crm_memory__industry')).toEqual(['Robotics']);
    expect(await factsOf('email')).toEqual([]);
    const edges = await rows<{ kind: string }>(`SELECT kind FROM knowledge_edge`);
    expect(edges.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['primary_contact', 'organization', 'works_at']),
    );
    const queries = sf.calls.filter((c) => c.path.includes('/services/data/v62.0/query?q='));
    expect(queries.length).toBe(3);
    expect(queries.every((c) => c.auth?.startsWith('Bearer sftok_'))).toBe(true);

    // The support renewal is deleted at Salesforce: the incremental run reads the feed and closes it.
    sf.calls.length = 0;
    sf.deleted = { Opportunity: [{ id: '006B', deletedDate: new Date().toISOString() }] };
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      fetched: 0,
      gone: 1,
      // amount, stage, status, owner of the deleted opportunity
      closed: 4,
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Negotiation']);
    expect(sf.calls.filter((c) => c.path.includes('/sobjects/Opportunity/deleted/')).length).toBe(
      1,
    );
  });

  it('JWT bearer: the preview runs as the integration user through one assertion exchange; the credential is stored encrypted', async () => {
    const credential = JSON.stringify({
      clientId: sf.jwt.clientId,
      username: sf.jwt.username,
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    sf.calls.length = 0;
    const preview = await f.http
      .post('/v1/admin/source-connections/preview')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'salesforce',
        config: { entities: ['deal', 'person'] },
        credential,
      });
    expect(preview.status).toBe(201);
    const byType = Object.fromEntries(
      preview.body.entities.map((e: { type: string }) => [e.type, e]),
    );
    expect(byType.deal.error).toBeNull();
    expect(byType.deal.records[0].facts).toEqual(
      expect.arrayContaining([{ predicate: 'crm_memory__deal_stage', object: 'Negotiation' }]),
    );
    expect(byType.deal.records[0].relations).toEqual(
      expect.arrayContaining([
        { kind: 'primary_contact', target: 'Ada Lovelace' },
        { kind: 'organization', target: 'Acme Robotics' },
      ]),
    );
    const exchanges = sf.calls.filter((c) => c.path === '/services/oauth2/token');
    expect(exchanges).toHaveLength(1);
    expect(new URLSearchParams(exchanges[0]!.body).get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'salesforce',
        vertical: 'crm',
        label: 'Salesforce (integration user)',
        config: { entities: ['organization'] },
        credential,
      });
    expect(conn.status).toBe(201);
    expect(conn.body.grantId).toBeNull();
    expect(JSON.stringify(conn.body)).not.toContain('PRIVATE KEY');
    const stored = await rows<{ credential: string }>(
      `SELECT credential FROM source_connection WHERE id = <record>$id`,
      { id: conn.body.id },
    );
    expect(stored[0]?.credential.startsWith('enc:v1:')).toBe(true);
    const run = await sync(conn.body.id);
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 1 });

    // A wrong key is the run's named failure, never a crash.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'crm_memory',
        sourceId: 'salesforce',
        vertical: 'crm',
        label: 'Salesforce (bad key)',
        config: {},
        credential: JSON.stringify({
          clientId: sf.jwt.clientId,
          username: sf.jwt.username,
          privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      });
    const failed = await sync(bad.body.id);
    expect(failed.body.summary.status).toBe('failed');
    expect(failed.body.summary.error).toMatch(/JWT bearer refused \(invalid_grant: signature\)/);
  });
});

function seed(sf: FakeSalesforce): void {
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
        OwnerId: '005A',
        Owner: { Name: 'Grace Hopper' },
        AccountId: '001A',
        Account: { Name: 'Acme Robotics' },
        ContactId: '003A',
        LastModifiedDate: '2026-09-15T10:00:00.000+0000',
      },
      {
        Id: '006B',
        Name: 'Support renewal',
        Amount: 1200,
        StageName: 'Closed Won',
        IsClosed: true,
        IsWon: true,
        Owner: { Name: 'Grace Hopper' },
        AccountId: '001A',
        Account: { Name: 'Acme Robotics' },
        LastModifiedDate: '2026-09-16T10:00:00.000+0000',
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
        Owner: { Name: 'Grace Hopper' },
        LastModifiedDate: '2026-09-01T10:00:00.000+0000',
      },
    ],
  };
}
