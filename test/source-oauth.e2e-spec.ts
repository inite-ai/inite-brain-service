/**
 * The brain as an outbound OAuth client + the Google Drive connector, end
 * to end against a REAL SurrealDB and one fake provider on loopback (W4):
 *  - the surface is dark without SOURCE_OAUTH_CLIENT; with it, readiness,
 *    the providers this deployment can connect and the redirect URI to register;
 *  - start → the consent URL (PKCE, the connector's scopes, a signed state)
 *    → the public callback with the code → a grant with the account label,
 *    tokens ENCRYPTED at rest, the PKCE verifier sent to the token endpoint;
 *    a forged state and a used state are refused on the page, never 500;
 *  - a gdrive connection needs `oauth:<grant>`; an `fs` one refuses it;
 *  - sync inline: the walk through the fake Drive API becomes documents;
 *    an expiring token is refreshed BEFORE the run (single call), a
 *    refresh the provider refuses marks the grant broken and the run fails
 *    by name; disconnecting revokes at the provider and the next run says so;
 *  - a plain operator credential (a `url` connection) is encrypted at rest too.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { FILE_MEMORY_PACK, WEB_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeCloud, type FakeCloud } from './fixtures/fake-cloud';

const COMPANY = 'co_source_oauth_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_GDRIVE',
  'SOURCE_KIND_URL',
  'SOURCE_OAUTH_GOOGLE_CLIENT_ID',
  'SOURCE_OAUTH_GOOGLE_CLIENT_SECRET',
  'SOURCE_OAUTH_GOOGLE_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('source OAuth + Google Drive (e2e)', () => {
  let f: AppFixture;
  let cloud: FakeCloud;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    cloud = await startFakeCloud();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.SOURCE_PLANE_ENABLED = '1';
    process.env.SOURCE_OAUTH_CLIENT = '1';
    process.env.SOURCE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.SOURCE_KIND_GDRIVE = '1';
    process.env.SOURCE_KIND_URL = '1';
    process.env.SOURCE_OAUTH_GOOGLE_CLIENT_ID = 'brain-test-client';
    process.env.SOURCE_OAUTH_GOOGLE_CLIENT_SECRET = 'brain-test-secret';
    process.env.SOURCE_OAUTH_GOOGLE_BASE_URL = cloud.base;
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.BRAIN_PUBLIC_URL = 'https://brain.example.test';
    f = await createApp({ companyId: COMPANY });
    cloud.google.folders = [{ id: 'f_docs', name: 'docs', parent: 'root' }];
    cloud.google.files = [
      {
        id: 'a',
        name: 'README.md',
        mimeType: 'text/markdown',
        content: '# Vault\nThe vault documents the payments gateway.',
        modified: '2026-01-01T00:00:00Z',
        parent: 'root',
      },
      {
        id: 'c',
        name: 'Runbook',
        mimeType: 'application/vnd.google-apps.document',
        content: 'On-call rotation: see docs/alerts.md.',
        modified: '2026-01-03T00:00:00Z',
        parent: 'f_docs',
        native: true,
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

  let grantId = '';
  let connectionId = '';

  it('is dark without SOURCE_OAUTH_CLIENT; with it, says what this deployment can connect', async () => {
    process.env.SOURCE_OAUTH_CLIENT = '0';
    expect((await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth())).status).toBe(
      404,
    );
    expect((await f.http.get('/v1/source-connections/oauth/callback?state=x&code=y')).status).toBe(
      404,
    );
    process.env.SOURCE_OAUTH_CLIENT = '1';
    const r = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
    expect(r.body.grants).toEqual([]);
    const google = r.body.providers.find((p: { id: string }) => p.id === 'google');
    expect(google).toMatchObject({
      configured: true,
      redirectUri: 'https://brain.example.test/v1/source-connections/oauth/callback',
    });
    expect(r.body.providers.find((p: { id: string }) => p.id === 'dropbox').configured).toBe(false);
  });

  it('start → consent URL → callback → a grant with the account, tokens encrypted, PKCE proven', async () => {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'google', connector: 'gdrive', origin: 'http://localhost:3030' });
    expect(start.status).toBe(201);
    const url = new URL(start.body.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${cloud.base}/o/oauth2/v2/auth`);
    expect(url.searchParams.get('client_id')).toBe('brain-test-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('drive.readonly');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://brain.example.test/v1/source-connections/oauth/callback',
    );
    const state = url.searchParams.get('state')!;
    expect(state).toBe(start.body.state);

    // A forged state opens nothing.
    const forged = await f.http.get(`/v1/source-connections/oauth/callback?state=${state}x&code=c`);
    expect(forged.status).toBe(200);
    expect(forged.text).toContain('invalid or missing state');

    cloud.codes.set('code-1', {});
    cloud.nextToken = { expiresIn: 30 }; // expires within the refresh skew — the first run must refresh
    const cb = await f.http.get(
      `/v1/source-connections/oauth/callback?state=${encodeURIComponent(state)}&code=code-1`,
    );
    expect(cb.status).toBe(200);
    expect(cb.headers['content-type']).toContain('text/html');
    expect(cb.text).toContain('owner@example.test');
    expect(cb.text).toContain('"http://localhost:3030"');
    expect(cb.text).not.toContain('code-1');
    expect(cb.text).not.toContain('tok_');
    const exchange = cloud.calls.find(
      (c) => c.path === '/token' && /authorization_code/.test(c.body),
    )!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBeTruthy();
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe('brain-test-secret');

    // The state is spent.
    const again = await f.http.get(
      `/v1/source-connections/oauth/callback?state=${encodeURIComponent(state)}&code=code-1`,
    );
    expect(again.text).toContain('already used');

    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    expect(grants.body.grants).toHaveLength(1);
    const g = grants.body.grants[0];
    expect(g).toMatchObject({
      provider: 'google',
      account: 'owner@example.test',
      status: 'active',
      refreshable: true,
    });
    expect(g.scopes).toContain('https://www.googleapis.com/auth/drive.readonly');
    grantId = g.id;
    expect(cb.text).toContain(grantId);

    const stored = await rows<{ tokens: string }>(`SELECT tokens FROM source_oauth_grant`);
    expect(stored[0]!.tokens.startsWith('enc:v1:')).toBe(true);
    expect(stored[0]!.tokens).not.toContain('tok_');
    expect(await rows(`SELECT * FROM source_oauth_state`)).toEqual([]);
  });

  it('a gdrive connection needs its grant; fs refuses one; the view names the grant, never the token', async () => {
    for (const manifest of [FILE_MEMORY_PACK, WEB_MEMORY_PACK]) {
      const install = await f.http
        .post('/v1/admin/packs')
        .set(auth())
        .send({ manifest, acceptSources: true, acceptModalities: true });
      expect([200, 201]).toContain(install.status);
    }
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    const entry = catalog.body.sources.find(
      (s: { packId: string; sourceId: string }) =>
        s.packId === 'file_memory' && s.sourceId === 'gdrive',
    );
    expect(entry).toMatchObject({
      availability: 'ready',
      oauth: { provider: 'google', title: 'Google', configured: true },
    });
    expect(entry.oauth.scopes).toContain('https://www.googleapis.com/auth/drive.readonly');
    const noGrant = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({ packId: 'file_memory', sourceId: 'gdrive', vertical: 'files', config: {} });
    expect(noGrant.status).toBe(400);
    expect(noGrant.body.message).toMatch(/connect one first/);
    const wrongKind = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'web_memory',
        sourceId: 'site',
        vertical: 'web',
        config: { urls: ['https://example.com/'] },
        credential: `oauth:${grantId}`,
      });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.message).toMatch(/takes a secret, not a connected account/);
    const unknown = await f.http.post('/v1/admin/source-connections').set(auth()).send({
      packId: 'file_memory',
      sourceId: 'gdrive',
      vertical: 'files',
      config: {},
      credential: 'oauth:source_oauth_grant:nope',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/no connected account/);

    const r = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'file_memory',
        sourceId: 'gdrive',
        vertical: 'files',
        label: 'Drive',
        config: { folderId: 'root' },
        credential: `oauth:${grantId}`,
      });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ connector: 'gdrive', hasCredential: true, grantId });
    expect(JSON.stringify(r.body)).not.toContain('tok_');
    connectionId = r.body.id;
  });

  it('sync: refreshes the expiring token first, walks the Drive into documents', async () => {
    const before = cloud.calls.filter(
      (c) => c.path === '/token' && /refresh_token/.test(c.body),
    ).length;
    cloud.nextToken = { expiresIn: 30 }; // the refreshed token expires soon too — for the broken-grant case
    const r = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(r.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'full',
      seen: 2,
      ingested: 2,
      failed: 0,
    });
    const refreshes = cloud.calls.filter(
      (c) => c.path === '/token' && /refresh_token/.test(c.body),
    );
    expect(refreshes.length).toBe(before + 1);
    expect(new URLSearchParams(refreshes[0]!.body).get('refresh_token')).toMatch(/^rt_/);

    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    expect(grants.body.grants[0].lastRefreshAt).not.toBeNull();

    const docs = await rows<{ title: string; originUri: string; meta: Record<string, unknown> }>(
      `SELECT title, originUri, meta FROM source_document WHERE kind = 'drive_file'`,
    );
    expect(docs.map((d) => d.title).sort()).toEqual(['README.md', 'Runbook']);
    expect(docs.find((d) => d.title === 'README.md')!.originUri).toBe(
      'https://drive.google.com/file/d/a/view',
    );
    expect(docs[0]!.meta).toMatchObject({ source_pack: 'file_memory', source_id: 'gdrive' });
    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items`)
      .set(auth());
    expect(items.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual([
      'a',
      'c',
    ]);
    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body.checkpoint).toMatchObject({ pageToken: expect.any(String) });
  });

  it('a refresh the provider refuses breaks the grant; the run fails by name', async () => {
    cloud.nextToken = { fail: 'invalid_grant' };
    const r = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(r.body.summary.status).toBe('failed');
    expect(r.body.summary.error).toMatch(/refresh failed \(invalid_grant/);
    expect(r.body.summary.error).toMatch(/reconnect it/);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    expect(grants.body.grants[0]).toMatchObject({ status: 'broken' });
    expect(grants.body.grants[0].lastError).toMatch(/invalid_grant/);
    const again = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(again.body.summary.error).toMatch(/is broken/);
    // A broken grant cannot be attached to a new connection either.
    const attach = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'file_memory',
        sourceId: 'gdrive_media',
        vertical: 'files',
        config: {},
        credential: `oauth:${grantId}`,
      });
    expect(attach.status).toBe(400);
    expect(attach.body.message).toMatch(/is broken/);
  });

  it('disconnect: revoked at the provider, the grant is revoked, the run says so', async () => {
    const r = await f.http
      .delete(`/v1/admin/source-connections/oauth/grants/${grantId}`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ revoked: true, providerRevoked: true });
    expect(cloud.calls.some((c) => c.path === '/revoke')).toBe(true);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    expect(grants.body.grants[0]).toMatchObject({ status: 'revoked', refreshable: false });
    const sync = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(sync.body.summary.error).toMatch(/is revoked/);
    expect(
      (await f.http.delete(`/v1/admin/source-connections/oauth/grants/nope`).set(auth())).status,
    ).toBe(404);
  });

  it('a plain operator credential is encrypted at rest too', async () => {
    const r = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'web_memory',
        sourceId: 'site',
        vertical: 'web',
        config: { urls: ['https://example.com/'] },
        credential: 'bearer-secret-xyz',
      });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ hasCredential: true, grantId: null });
    const stored = await rows<{ credential: string }>(
      `SELECT credential FROM type::record('source_connection', $tail)`,
      { tail: String(r.body.id).split(':')[1] },
    );
    expect(stored[0]!.credential.startsWith('enc:v1:')).toBe(true);
    expect(stored[0]!.credential).not.toContain('bearer-secret-xyz');
  });
});
