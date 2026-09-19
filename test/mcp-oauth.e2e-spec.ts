/**
 * The brain as an OAuth client of an MCP server it has never seen, end
 * to end on a REAL SurrealDB (W4.3): the server's 401 names its
 * protected-resource metadata → the authorization server's metadata →
 * a client registered dynamically → PKCE consent with the RFC 8707
 * resource → a `mcp` grant for that resource → a pack's `auth: oauth`
 * MCP source connected as it → a sync that reads resources with the
 * bearer → an expired token refreshed at the discovered endpoint →
 * disconnect revoked there. A grant for another server is refused at
 * create; an authorization server without registration takes the
 * operator's client; the route is dark without the flag.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeMcpOAuth, type FakeMcpOAuth } from './fixtures/fake-mcp-oauth';

const COMPANY = 'co_mcp_oauth_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_MCP_OAUTH',
  'SOURCE_KIND_MCP',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

const PREDICATE = {
  localId: 'page_note',
  displayLabel: 'page note',
  description: 'TYPE subject is a topic; value is a note from the wiki',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
};

describe('MCP client OAuth (e2e)', () => {
  let f: AppFixture;
  let mcp: FakeMcpOAuth;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    mcp = await startFakeMcpOAuth();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_MCP_OAUTH: '1',
      SOURCE_KIND_MCP: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({
        manifest: {
          id: 'signed_wiki',
          version: '1.0.0',
          description: 'A wiki behind an MCP server that signs in.',
          predicates: [PREDICATE],
          sources: [
            { id: 'wiki', kind: 'mcp', transport: 'http', auth: 'oauth', shape: 'document' },
          ],
        },
        acceptSources: true,
      });
    expect([200, 201]).toContain(install.status);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await mcp.close();
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  /** Start → the fake's Allow page → the brain's callback; the grant id from the grants list. */
  const signIn = async (body: Record<string, unknown>) => {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/mcp/start')
      .set(auth())
      .send({ serverUrl: mcp.serverUrl, allowPrivate: true, ...body });
    if (start.status !== 201) return { start, grant: null };
    const authorize = new URL(start.body.authorizeUrl);
    const page = await fetch(authorize.toString());
    const html = await page.text();
    const allow = /id="allow" href="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
    const back = new URL(allow);
    const cb = await f.http.get(`${back.pathname}${back.search}`);
    expect(cb.text).toContain('Connected');
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find(
      (g: { provider: string; status: string }) => g.provider === 'mcp' && g.status === 'active',
    );
    return { start, grant };
  };

  it('the catalogue says the source signs in; without the flag the route is dark', async () => {
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    const entry = catalog.body.sources.find((s: { sourceId: string }) => s.sourceId === 'wiki');
    expect(entry).toMatchObject({
      connector: 'mcp',
      availability: 'ready',
      mcp: { transport: 'http', auth: 'oauth', url: null },
      oauth: { provider: 'mcp', configured: true, scopes: [] },
    });
    process.env.SOURCE_MCP_OAUTH = '0';
    const dark = await f.http
      .post('/v1/admin/source-connections/oauth/mcp/start')
      .set(auth())
      .send({ serverUrl: mcp.serverUrl });
    expect(dark.status).toBe(404);
    process.env.SOURCE_MCP_OAUTH = '1';
  });

  it('discovers the authorization server from the 401, registers a client, consents with PKCE + resource, and the source syncs as the grant; refresh and revoke go through the discovered endpoints', async () => {
    const { start, grant } = await signIn({});
    expect(start.status).toBe(201);
    expect(start.body.resource).toBe(mcp.serverUrl);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.pathname).toBe('/auth/authorize');
    expect(authorize.searchParams.get('resource')).toBe(mcp.serverUrl);
    expect(authorize.searchParams.get('scope')).toBe('resources:read');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    // The probe hit the server, the metadata was read, the client registered as a public PKCE client.
    expect(mcp.calls.some((c) => c.path === '/mcp' && c.method === 'POST' && c.auth === null)).toBe(
      true,
    );
    expect(mcp.calls.some((c) => c.path === '/.well-known/oauth-protected-resource/mcp')).toBe(
      true,
    );
    expect(mcp.calls.some((c) => c.path === '/.well-known/oauth-authorization-server/auth')).toBe(
      true,
    );
    const registration = mcp.calls.find((c) => c.path === '/auth/register')!;
    expect(JSON.parse(registration.body)).toMatchObject({
      client_name: 'INITE Brain',
      redirect_uris: ['https://brain.example.test/v1/source-connections/oauth/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(mcp.clients.size).toBe(1);
    const exchange = mcp.calls.filter((c) => c.path === '/auth/token').at(-1)!;
    const params = new URLSearchParams(exchange.body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('resource')).toBe(mcp.serverUrl);
    expect(params.get('client_secret')).toBeNull();
    expect(grant).toMatchObject({
      provider: 'mcp',
      resource: mcp.serverUrl,
      apiBase: mcp.base,
      refreshable: true,
      scopes: ['resources:read'],
    });
    expect(grant.account).toBe(new URL(mcp.base).host);
    const clients = await rows<{ registration: string; tokenAuth: string; clientSecret?: string }>(
      `SELECT registration, tokenAuth, clientSecret FROM source_oauth_client`,
    );
    expect(clients).toEqual([{ registration: 'dynamic', tokenAuth: 'none' }]);

    // A second start reuses the client (no second registration).
    const again = await signIn({});
    expect(again.start.status).toBe(201);
    expect(mcp.clients.size).toBe(1);

    const other = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'signed_wiki',
        sourceId: 'wiki',
        vertical: 'wiki',
        label: 'Wrong server',
        config: { url: 'https://other.example.test/mcp', allowPrivate: true },
        credential: `oauth:${grant.id}`,
      });
    expect(other.status).toBe(400);
    expect(other.body.message).toMatch(/is for .* not https:\/\/other\.example\.test\/mcp/);
    const noGrant = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'signed_wiki',
        sourceId: 'wiki',
        vertical: 'wiki',
        config: { url: mcp.serverUrl, allowPrivate: true },
      });
    expect(noGrant.status).toBe(400);
    expect(noGrant.body.message).toMatch(/signs in at .* sign in first/);

    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'signed_wiki',
        sourceId: 'wiki',
        vertical: 'wiki',
        label: 'Signed wiki',
        config: { url: mcp.serverUrl, allowPrivate: true },
        credential: `oauth:${grant.id}`,
      });
    expect(conn.status).toBe(201);
    expect(conn.body.grantId).toBe(grant.id);
    mcp.calls.length = 0;
    const sync = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(sync.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 1,
      ingested: 1,
      failed: 0,
    });
    const reads = mcp.calls.filter((c) => c.path === '/mcp');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.auth?.startsWith('Bearer mtok_'))).toBe(true);
    const docs = await rows<{ title: string }>(`SELECT title FROM source_document`);
    expect(docs.map((d) => d.title)).toContain('Intro');

    // The token expires: the next run refreshes at the discovered token endpoint, with the resource.
    await rows(`UPDATE source_oauth_grant SET tokens = $tokens WHERE id = <record>$id`, {
      id: grant.id,
      tokens: await expiredTokens(grant.id),
    });
    mcp.calls.length = 0;
    const second = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(second.body.summary.status).toBe('succeeded');
    const refresh = mcp.calls.find((c) => c.path === '/auth/token')!;
    const rp = new URLSearchParams(refresh.body);
    expect(rp.get('grant_type')).toBe('refresh_token');
    expect(rp.get('resource')).toBe(mcp.serverUrl);

    const revoke = await f.http
      .delete(`/v1/admin/source-connections/oauth/grants/${grant.id}`)
      .set(auth());
    expect(revoke.body).toEqual({ revoked: true, providerRevoked: true });
    expect(mcp.revoked.length).toBe(1);
    const failed = await f.http
      .post(`/v1/admin/source-connections/${conn.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(failed.body.summary.status).toBe('failed');
    expect(failed.body.summary.error).toMatch(/revoked/);
  });

  it('an authorization server without dynamic registration takes the client the operator registered', async () => {
    await rows(`DELETE source_oauth_client`);
    mcp.registration = false;
    const refused = await f.http
      .post('/v1/admin/source-connections/oauth/mcp/start')
      .set(auth())
      .send({ serverUrl: mcp.serverUrl, allowPrivate: true });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/no dynamic client registration/);
    mcp.clients.set('operator-client', 'operator-secret');
    const { start, grant } = await signIn({
      client: { clientId: 'operator-client', clientSecret: 'operator-secret' },
    });
    expect(start.status).toBe(201);
    expect(grant).toMatchObject({ provider: 'mcp', resource: mcp.serverUrl });
    const exchange = mcp.calls.filter((c) => c.path === '/auth/token').at(-1)!;
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe('operator-secret');
    const clients = await rows<{ registration: string; tokenAuth: string; clientSecret: string }>(
      `SELECT registration, tokenAuth, clientSecret FROM source_oauth_client`,
    );
    expect(clients[0]).toMatchObject({ registration: 'operator', tokenAuth: 'body' });
    expect(clients[0]!.clientSecret.startsWith('enc:v1:')).toBe(true);
    mcp.registration = true;
  });

  /** The grant's token set with the access token expired — the same encrypted JSON the service writes. */
  async function expiredTokens(grantId: string): Promise<string> {
    const [row] = await rows<{ tokens: string }>(
      `SELECT tokens FROM source_oauth_grant WHERE id = <record>$id`,
      { id: grantId },
    );
    const { decryptSecret, encryptSecret } = await import('../src/source-plane/credential-cipher');
    const set = JSON.parse(decryptSecret(row!.tokens)) as Record<string, unknown>;
    return encryptSecret(
      JSON.stringify({ ...set, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
  }
});
