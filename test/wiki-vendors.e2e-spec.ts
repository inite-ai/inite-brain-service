/**
 * The wiki vendors as connected accounts, end to end on a REAL SurrealDB
 * (W4.5), each against the fake wiki server:
 *  - Notion: the OAuth flow the way Notion runs it (the app's credentials
 *    as HTTP Basic, a JSON body validated strictly — no PKCE verifier —
 *    no refresh token, the workspace as the account), then a sync walks
 *    the pages search lists into documents — the block tree as
 *    markdown-like text, a database row's properties as lines — an
 *    incremental run stops at the checkpoint and fetches only what was
 *    edited, a full run marks an archived page gone;
 *  - Confluence Cloud: the 3LO flow (JSON, offline_access, a rotating
 *    refresh token), the site from accessible-resources, a space filter,
 *    the storage format reduced to text, the version as the revision,
 *    an expired token refreshed before the next run.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { WEB_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeWiki, type FakeWiki } from './fixtures/fake-wiki';

const COMPANY = 'co_wiki_vendors_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_NOTION',
  'SOURCE_KIND_CONFLUENCE',
  'SOURCE_OAUTH_NOTION_CLIENT_ID',
  'SOURCE_OAUTH_NOTION_CLIENT_SECRET',
  'SOURCE_OAUTH_NOTION_BASE_URL',
  'SOURCE_OAUTH_ATLASSIAN_CLIENT_ID',
  'SOURCE_OAUTH_ATLASSIAN_CLIENT_SECRET',
  'SOURCE_OAUTH_ATLASSIAN_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('wiki vendors: notion / confluence (e2e)', () => {
  let f: AppFixture;
  let wiki: FakeWiki;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    wiki = await startFakeWiki();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_NOTION: '1',
      SOURCE_KIND_CONFLUENCE: '1',
      SOURCE_OAUTH_NOTION_CLIENT_ID: 'nt-client',
      SOURCE_OAUTH_NOTION_CLIENT_SECRET: 'nt-secret',
      SOURCE_OAUTH_NOTION_BASE_URL: wiki.base,
      SOURCE_OAUTH_ATLASSIAN_CLIENT_ID: 'at-client',
      SOURCE_OAUTH_ATLASSIAN_CLIENT_SECRET: 'at-secret',
      SOURCE_OAUTH_ATLASSIAN_BASE_URL: wiki.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seedNotion(wiki);
    seedConfluence(wiki);
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: WEB_MEMORY_PACK, acceptSources: true, acceptModalities: true });
    expect([200, 201]).toContain(install.status);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await wiki.close();
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const connect = (body: Record<string, unknown>) =>
    f.http.post('/v1/admin/source-connections').set(auth()).send(body);
  const sync = (id: string, full = false) =>
    f.http.post(`/v1/admin/source-connections/${id}/sync`).set(auth()).send({ inline: true, full });
  /** Start a provider's flow, follow the fake consent page's Allow link through the callback, return the grant. */
  async function consent(provider: string, connector: string) {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider, connector });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.origin).toBe(wiki.base);
    const page = await fetch(authorize.toString());
    const href = /href="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const back = new URL(href!);
    const cb = await f.http.get(`${back.pathname}${back.search}`);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find(
      (g: { provider: string; status: string }) => g.provider === provider && g.status === 'active',
    );
    return { cb, grant, authorize };
  }
  /** The latest document of that title (a re-read revision is a new document; the older one keeps its closed facts). */
  const docText = async (kind: string, title: string): Promise<string> => {
    const docs = await rows<{ id: unknown; title: string }>(
      `SELECT id, title, createdAt FROM source_document WHERE kind = $kind AND title = $title ORDER BY createdAt DESC LIMIT 1`,
      { kind, title },
    );
    expect(docs).toHaveLength(1);
    const chunks = await rows<{ text: string }>(
      `SELECT text FROM source_chunk WHERE docId = $doc`,
      { doc: docs[0]!.id },
    );
    return chunks.map((c) => c.text).join('');
  };
  async function expireTokens(grantId: string): Promise<void> {
    const [row] = await rows<{ tokens: string }>(
      `SELECT tokens FROM source_oauth_grant WHERE id = <record>$id`,
      { id: grantId },
    );
    const { decryptSecret, encryptSecret } = await import('../src/source-plane/credential-cipher');
    const set = JSON.parse(decryptSecret(row!.tokens)) as Record<string, unknown>;
    await rows(`UPDATE source_oauth_grant SET tokens = $tokens WHERE id = <record>$id`, {
      id: grantId,
      tokens: encryptSecret(
        JSON.stringify({ ...set, expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ),
    });
  }

  it('notion: OAuth as Notion runs it (Basic + strict JSON, no PKCE, no refresh), the workspace as the account; pages walked into documents', async () => {
    const { cb, grant, authorize } = await consent('notion', 'notion');
    expect(authorize.searchParams.get('owner')).toBe('user');
    expect(authorize.searchParams.has('code_challenge')).toBe(false);
    expect(cb.text).toContain('Connected Acme Wiki (notion)');
    const exchange = wiki.calls.find((c) => c.path === '/v1/oauth/token')!;
    expect(exchange.auth).toMatch(/^Basic /);
    expect(exchange.headers['content-type']).toBe('application/json');
    expect(Object.keys(JSON.parse(exchange.body) as object).sort()).toEqual([
      'code',
      'grant_type',
      'redirect_uri',
    ]);
    expect(grant).toMatchObject({
      account: 'Acme Wiki',
      refreshable: false,
      accessExpiresAt: null,
    });
    expect(wiki.calls.find((c) => c.path === '/v1/users/me')?.headers['notion-version']).toBe(
      '2022-06-28',
    );

    const conn = await connect({
      packId: 'web_memory',
      sourceId: 'notion',
      vertical: 'wiki',
      label: 'Notion',
      config: {},
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      fetched: 3,
      ingested: 3,
      failed: 0,
    });
    const handbook = await docText('notion_page', 'Engineering handbook');
    expect(handbook).toContain('# Engineering handbook');
    expect(handbook).toContain('## On-call');
    expect(handbook).toContain('- Rotate weekly (https://acme.test/oncall)');
    expect(handbook).toContain('[x] Pager set up');
    expect(handbook).toContain('```bash\nkubectl get pods\n```');
    expect(handbook).toContain('  - nested under the toggle');
    expect(handbook).toContain('Region | Owner');
    expect(handbook).toContain('[page] Runbooks');
    const row = await docText('notion_page', 'Migrate billing to v2');
    expect(row).toContain('Status: In progress');
    expect(row).toContain('Owner: Grace Hopper');
    expect(row).toContain('Due: 2026-10-01');
    expect(row).toContain('Tags: platform, billing');

    // Nothing edited: the incremental run stops at the checkpoint and fetches nothing.
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 0,
      fetched: 0,
    });
    // One page edited, one archived: incremental fetches the edit; full sweeps the archived one.
    const w = wiki.notion;
    const hb = w.pages.get('page-handbook')!;
    hb.lastEdited = '2026-09-20T09:00:00.000Z';
    w.blocks.set('page-handbook', [
      {
        id: 'b-new',
        type: 'paragraph',
        body: { rich_text: [{ plain_text: 'Updated: escalation goes to the duty manager.' }] },
      },
    ]);
    w.pages.get('page-runbooks')!.archived = true;
    const third = await sync(conn.body.id);
    expect(third.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 1,
      changed: 1,
      fetched: 1,
      gone: 0,
    });
    expect(await docText('notion_page', 'Engineering handbook')).toContain('duty manager');
    const full = await sync(conn.body.id, true);
    expect(full.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'full',
      seen: 2,
      gone: 1,
    });
  });

  it('notion: rootPageIds walks the named subtrees instead of search; a page not shared is skipped by name', async () => {
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find((g: { provider: string }) => g.provider === 'notion');
    wiki.notion.pages.get('page-runbooks')!.archived = false;
    // The handbook's edit above replaced its blocks: give it its child page back for the subtree walk.
    wiki.notion.blocks.set('page-handbook', [
      {
        id: 'b-new',
        type: 'paragraph',
        body: { rich_text: [{ plain_text: 'Updated: escalation goes to the duty manager.' }] },
      },
      { id: 'page-runbooks', type: 'child_page', body: { title: 'Runbooks' } },
    ]);
    const conn = await connect({
      packId: 'web_memory',
      sourceId: 'notion',
      vertical: 'wiki',
      label: 'Notion (handbook only)',
      config: { rootPageIds: ['page-handbook', 'page-missing'] },
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    wiki.calls.length = 0;
    const run = await sync(conn.body.id);
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 2, fetched: 2 });
    expect(wiki.calls.some((c) => c.path === '/v1/search')).toBe(false);
    const items = await f.http
      .get(`/v1/admin/source-connections/${conn.body.id}/items`)
      .set(auth());
    expect(items.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual([
      'page-handbook',
      'page-runbooks',
    ]);
  });

  it('confluence: 3LO OAuth (JSON, offline_access, rotating refresh), the site from accessible-resources, a space filter, storage → text, a refresh before the next run', async () => {
    const { cb, grant, authorize } = await consent('atlassian', 'confluence');
    expect(authorize.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(authorize.searchParams.get('scope')).toContain('offline_access');
    expect(authorize.searchParams.get('scope')).toContain('read:page:confluence');
    expect(cb.text).toContain('Connected ada@acme.test (atlassian)');
    const exchange = wiki.calls.find((c) => c.path === '/oauth/token')!;
    expect(exchange.headers['content-type']).toBe('application/json');
    expect(JSON.parse(exchange.body)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'at-client',
      client_secret: 'at-secret',
    });
    expect(grant).toMatchObject({ account: 'ada@acme.test', refreshable: true });

    const conn = await connect({
      packId: 'web_memory',
      sourceId: 'confluence',
      vertical: 'wiki',
      label: 'Confluence ENG',
      config: { spaceKeys: ['ENG'], includeBlogposts: true },
      credential: `oauth:${grant.id}`,
    });
    expect(conn.status).toBe(201);
    wiki.calls.length = 0;
    const first = await sync(conn.body.id);
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 3,
      fetched: 3,
      ingested: 3,
      failed: 0,
    });
    const listing = wiki.calls.find((c) => c.path.includes('/wiki/api/v2/pages?'))!;
    const q = new URL(listing.path, wiki.base).searchParams;
    expect(q.get('space-id')).toBe('space-eng');
    expect(q.get('sort')).toBe('-modified-date');
    const deploy = await docText('confluence_page', 'Deploy process');
    expect(deploy).toContain('# Deploy process');
    expect(deploy).toContain('Every deploy goes through the pipeline');
    expect(deploy).toContain('kubectl rollout status');
    expect(deploy).toContain('Rollback playbook');
    expect(deploy).not.toContain('<ac:');
    expect(deploy).not.toContain('CDATA');
    const post = await docText('confluence_blogpost', 'Welcome to ENG');
    expect(post).toContain('Say hi');
    const items = await f.http
      .get(`/v1/admin/source-connections/${conn.body.id}/items`)
      .set(auth());
    const byId = Object.fromEntries(
      items.body.items.map((i: { externalId: string; revision: string }) => [
        i.externalId,
        i.revision,
      ]),
    );
    expect(byId).toMatchObject({
      'p-deploy': 'v:3',
      'p-oncall': 'v:1',
      'blogpost:b-welcome': 'v:1',
    });
    expect(byId['p-hr']).toBeUndefined();

    // One page revised: the next run is incremental and fetches it alone, after refreshing the expired token (rotated refresh token).
    const a = wiki.atlassian;
    const d = a.pages.get('p-deploy')!;
    d.version = 4;
    d.modified = '2026-09-21T10:00:00.000Z';
    d.storage = '<p>Every deploy goes through the pipeline, then the canary.</p>';
    await expireTokens(grant.id);
    wiki.calls.length = 0;
    const second = await sync(conn.body.id);
    expect(second.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 1,
      changed: 1,
      fetched: 1,
    });
    const refresh = wiki.calls.find((c) => c.path === '/oauth/token')!;
    expect(JSON.parse(refresh.body)).toMatchObject({ grant_type: 'refresh_token' });
    expect(await docText('confluence_page', 'Deploy process')).toContain('then the canary');
    const [row] = await rows<{ tokens: string }>(
      `SELECT tokens FROM source_oauth_grant WHERE id = <record>$id`,
      { id: grant.id },
    );
    const { decryptSecret } = await import('../src/source-plane/credential-cipher');
    const set = JSON.parse(decryptSecret(row!.tokens)) as { refreshToken: string };
    expect(a.refreshSpent.has(set.refreshToken)).toBe(false);
    expect(a.refreshSpent.size).toBe(1);
  });

  it('confluence: an unknown space key fails by name; a site the account does not reach fails by name', async () => {
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    const grant = grants.body.grants.find((g: { provider: string }) => g.provider === 'atlassian');
    const bad = await connect({
      packId: 'web_memory',
      sourceId: 'confluence',
      vertical: 'wiki',
      label: 'bad space',
      config: { spaceKeys: ['NOPE'] },
      credential: `oauth:${grant.id}`,
    });
    const run = await sync(bad.body.id);
    expect(run.body.summary.status).toBe('failed');
    expect(run.body.summary.error).toMatch(/no space with key NOPE/);
    const other = await connect({
      packId: 'web_memory',
      sourceId: 'confluence',
      vertical: 'wiki',
      label: 'bad site',
      config: { site: 'other.atlassian.net' },
      credential: `oauth:${grant.id}`,
    });
    const run2 = await sync(other.body.id);
    expect(run2.body.summary.status).toBe('failed');
    expect(run2.body.summary.error).toMatch(
      /no site "other\.atlassian\.net" among the account's 1/,
    );
  });
});

function seedNotion(wiki: FakeWiki): void {
  const n = wiki.notion;
  n.pages.set('page-handbook', {
    id: 'page-handbook',
    title: 'Engineering handbook',
    lastEdited: '2026-09-10T10:00:00.000Z',
  });
  n.pages.set('page-runbooks', {
    id: 'page-runbooks',
    title: 'Runbooks',
    lastEdited: '2026-09-05T10:00:00.000Z',
    parent: { type: 'page_id', page_id: 'page-handbook' },
  });
  n.pages.set('row-billing', {
    id: 'row-billing',
    title: 'Migrate billing to v2',
    lastEdited: '2026-09-08T10:00:00.000Z',
    parent: { type: 'database_id' },
    properties: {
      Status: { type: 'status', status: { name: 'In progress' } },
      Owner: { type: 'people', people: [{ name: 'Grace Hopper' }] },
      Due: { type: 'date', date: { start: '2026-10-01', end: null } },
      Tags: { type: 'multi_select', multi_select: [{ name: 'platform' }, { name: 'billing' }] },
      Estimate: { type: 'number', number: 13 },
      Done: { type: 'checkbox', checkbox: false },
    },
  });
  n.blocks.set('page-handbook', [
    { id: 'b1', type: 'heading_2', body: { rich_text: [{ plain_text: 'On-call' }] } },
    {
      id: 'b2',
      type: 'bulleted_list_item',
      body: { rich_text: [{ plain_text: 'Rotate weekly', href: 'https://acme.test/oncall' }] },
    },
    {
      id: 'b3',
      type: 'to_do',
      body: { rich_text: [{ plain_text: 'Pager set up' }], checked: true },
    },
    {
      id: 'b4',
      type: 'code',
      body: { rich_text: [{ plain_text: 'kubectl get pods' }], language: 'bash' },
    },
    { id: 'b5', type: 'toggle', body: { rich_text: [{ plain_text: 'More' }] }, hasChildren: true },
    { id: 'b6', type: 'table', body: { table_width: 2 }, hasChildren: true },
    // A child_page block's id IS the child page's id — that is how a subtree walk finds it.
    { id: 'page-runbooks', type: 'child_page', body: { title: 'Runbooks' } },
  ]);
  n.blocks.set('b5', [
    {
      id: 'b5a',
      type: 'bulleted_list_item',
      body: { rich_text: [{ plain_text: 'nested under the toggle' }] },
    },
  ]);
  n.blocks.set('b6', [
    {
      id: 'b6a',
      type: 'table_row',
      body: { cells: [[{ plain_text: 'Region' }], [{ plain_text: 'Owner' }]] },
    },
    {
      id: 'b6b',
      type: 'table_row',
      body: { cells: [[{ plain_text: 'EU' }], [{ plain_text: 'Ada' }]] },
    },
  ]);
  n.blocks.set('page-runbooks', [
    {
      id: 'r1',
      type: 'paragraph',
      body: { rich_text: [{ plain_text: 'Restart the queue: see ops.' }] },
    },
  ]);
  n.blocks.set('row-billing', [
    {
      id: 'd1',
      type: 'paragraph',
      body: { rich_text: [{ plain_text: 'Cut over on the first of the month.' }] },
    },
  ]);
}

function seedConfluence(wiki: FakeWiki): void {
  const a = wiki.atlassian;
  a.spaces = [
    { id: 'space-eng', key: 'ENG', name: 'Engineering' },
    { id: 'space-hr', key: 'HR', name: 'People' },
  ];
  a.pages.set('p-deploy', {
    id: 'p-deploy',
    title: 'Deploy process',
    spaceId: 'space-eng',
    version: 3,
    modified: '2026-09-12T10:00:00.000Z',
    storage:
      '<p>Every deploy goes through the pipeline.</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[kubectl rollout status deploy/api]]></ac:plain-text-body></ac:structured-macro><p>See <ac:link><ri:page ri:content-title="Rollback playbook" /></ac:link>.</p>',
  });
  a.pages.set('p-oncall', {
    id: 'p-oncall',
    title: 'On-call',
    spaceId: 'space-eng',
    version: 1,
    modified: '2026-09-01T10:00:00.000Z',
    storage: '<h2>Rota</h2><p>Weekly.</p>',
  });
  a.pages.set('p-hr', {
    id: 'p-hr',
    title: 'Leave policy',
    spaceId: 'space-hr',
    version: 1,
    modified: '2026-09-11T10:00:00.000Z',
    storage: '<p>25 days.</p>',
  });
  a.blogposts.set('b-welcome', {
    id: 'b-welcome',
    title: 'Welcome to ENG',
    spaceId: 'space-eng',
    version: 1,
    modified: '2026-08-01T10:00:00.000Z',
    storage: '<p>Say hi in #eng.</p>',
  });
}
