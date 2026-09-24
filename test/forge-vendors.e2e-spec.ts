/**
 * The forge as memory, end to end on a REAL SurrealDB (W4.8), against
 * the fake GitHub:
 *  - the OAuth app (the token endpoint answers JSON only because the
 *    brain asks for it, no PKCE, no refresh, the login as the account);
 *  - issues and pull requests as conversations: one row per thread,
 *    `updated_at` the revision, the body and every comment as turns
 *    through the mention door; a label filter; `includePullRequests:
 *    false`; an incremental run listing from the checkpoint and a new
 *    comment bringing the whole thread back;
 *  - the docs of the tree as documents: one recursive tree call, the
 *    blob sha the revision, `paths` and the media table deciding, a
 *    changed file re-read and a removed one gone on a full walk.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { blobSha, startFakeGithub, type FakeGithub } from './fixtures/fake-github';

const COMPANY = 'co_forge_vendors_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_GITHUB',
  'SOURCE_OAUTH_GITHUB_CLIENT_ID',
  'SOURCE_OAUTH_GITHUB_CLIENT_SECRET',
  'SOURCE_OAUTH_GITHUB_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'EPISODE_SUBSTRATE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

interface Episode {
  conversationId: string;
  messageId: string;
  text: string;
  occurredAt: string;
}

describe('forge: github (e2e)', () => {
  let f: AppFixture;
  let gh: FakeGithub;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    gh = await startFakeGithub();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_GITHUB: '1',
      SOURCE_OAUTH_GITHUB_CLIENT_ID: 'gh-client',
      SOURCE_OAUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
      SOURCE_OAUTH_GITHUB_BASE_URL: gh.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      EPISODE_SUBSTRATE_ENABLED: '1',
      INGEST_EPISODE_ONLY: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seed(gh);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await gh.close();
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
  const items = (id: string) =>
    f.http.get(`/v1/admin/source-connections/${id}/items?limit=100`).set(auth());
  const episodesOf = (recorder: string) =>
    rows<Episode>(
      `SELECT conversationId, messageId, text, occurredAt FROM episode WHERE source.recorder = $recorder ORDER BY occurredAt ASC`,
      { recorder },
    );
  const docText = async (title: string): Promise<string> => {
    const docs = await rows<{ id: unknown }>(
      `SELECT id, title, createdAt FROM source_document WHERE title = $title ORDER BY createdAt DESC LIMIT 1`,
      { title },
    );
    expect(docs).toHaveLength(1);
    const chunks = await rows<{ text: string }>(
      `SELECT text FROM source_chunk WHERE docId = $doc`,
      {
        doc: docs[0]!.id,
      },
    );
    return chunks.map((c) => c.text).join('');
  };
  async function grant(): Promise<{ id: string; account: string; refreshable: boolean }> {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(auth())
      .send({ provider: 'github', connector: 'github' });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    const page = await fetch(authorize.toString());
    const href = /href="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const back = new URL(href!);
    await f.http.get(`${back.pathname}${back.search}`);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    return grants.body.grants.find((g: { provider: string }) => g.provider === 'github');
  }

  it('issues and pull requests are conversations: the body and every comment as turns, back whole when one is added', async () => {
    // code_memory is a BUILTIN: it is seeded into every tenant, so its
    // forge entries are in the catalogue without an install.
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    expect(
      catalog.body.sources
        .filter((s: { packId: string }) => s.packId === 'code_memory')
        .map((s: { sourceId: string; availability: string }) => `${s.sourceId}:${s.availability}`),
    ).toEqual(expect.arrayContaining(['github_issues:ready', 'github_docs:ready']));
    const g = await grant();
    expect(g).toMatchObject({ account: 'gracehopper', refreshable: false });
    // The token endpoint was asked for JSON — github.com answers a form otherwise.
    const exchange = gh.calls.find((c) => c.path === '/login/oauth/access_token')!;
    expect(exchange.accept).toContain('application/json');

    const conn = await connect({
      packId: 'code_memory',
      sourceId: 'github_issues',
      vertical: 'code',
      label: 'Handbook issues',
      config: { repo: 'acme/handbook', since: '2026-09-01' },
      credential: `oauth:${g.id}`,
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

    const eps = await episodesOf(conn.body.recorder);
    // Issue 12 (body + 2 comments), PR 14 (body), issue 15 (body only).
    expect(eps).toHaveLength(5);
    const thread = eps.filter((e) => e.conversationId === 'gh:acme/handbook#12');
    expect(thread.map((e) => e.messageId)).toEqual(['issue-12', 'comment-1', 'comment-2']);
    expect(thread[0]!.text).toContain('Grace Hopper: Issue #12: Retries hammer the API on 429');
    expect(thread[1]!.text).toBe('Linus Berg: Agreed — we decided to back off exponentially.');
    expect(eps.find((e) => e.conversationId === 'gh:acme/handbook#14')?.text).toContain(
      'PR #14: Honour Retry-After',
    );
    const catalogue = await items(conn.body.id);
    expect(
      catalogue.body.items.find((i: { externalId: string }) => i.externalId === 'issue/14'),
    ).toMatchObject({
      title: '#14 Honour Retry-After',
      path: 'pr/14',
      revision: 'u:2026-09-14T10:00:00Z',
      originUri: 'https://github.com/acme/handbook/pull/14',
    });

    // Nothing changed: the incremental run lists from the checkpoint and re-reads nothing.
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      ingested: 0,
    });
    const listed = new URL(
      gh.calls.filter((c) => c.path.startsWith('/repos/acme/handbook/issues?')).at(-1)!.path,
      gh.base,
    );
    expect(Date.parse(listed.searchParams.get('since')!)).toBeGreaterThan(Date.parse('2026-09-01'));

    // A new comment moves the thread's updated_at: the whole thread lands again.
    const issue12 = gh.issues.find((i) => i.number === 12)!;
    issue12.comments!.push({
      id: 3,
      user: { login: 'gracehopper', name: 'Grace Hopper' },
      body: 'Shipped in 2.4.1.',
      createdAt: new Date().toISOString(),
    });
    issue12.updatedAt = new Date().toISOString();
    const third = await sync(conn.body.id);
    expect(third.body.summary).toMatchObject({ status: 'succeeded', changed: 1, ingested: 1 });
    const after = await episodesOf(conn.body.recorder);
    expect(after.find((e) => e.messageId === 'comment-3')?.text).toBe(
      'Grace Hopper: Shipped in 2.4.1.',
    );
  }, 60_000);

  it('a label filter and includePullRequests: false narrow what is read', async () => {
    const g = await grant();
    const conn = await connect({
      packId: 'code_memory',
      sourceId: 'github_issues',
      vertical: 'code',
      config: {
        repo: 'acme/handbook',
        since: '2026-09-01',
        labels: ['bug'],
        includePullRequests: false,
      },
      credential: `oauth:${g.id}`,
    });
    const run = await sync(conn.body.id);
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 1, ingested: 1 });
    const catalogue = await items(conn.body.id);
    expect(catalogue.body.items.map((i: { externalId: string }) => i.externalId)).toEqual([
      'issue/12',
    ]);
  }, 60_000);

  it('the docs of the tree are documents: the blob sha is the revision, a removed file is gone on a full walk', async () => {
    const g = await grant();
    const conn = await connect({
      packId: 'code_memory',
      sourceId: 'github_docs',
      vertical: 'code',
      label: 'Handbook docs',
      config: { repo: 'acme/handbook', paths: ['docs/'] },
      credential: `oauth:${g.id}`,
    });
    const first = await sync(conn.body.id);
    // README.md is outside `docs/`; the PNG is not a text document.
    expect(first.body.summary).toMatchObject({
      status: 'succeeded',
      seen: 2,
      fetched: 2,
      ingested: 2,
      failed: 0,
    });
    expect(await docText('runbook.md')).toContain('# Runbook');
    const catalogue = await items(conn.body.id);
    expect(
      catalogue.body.items.find(
        (i: { externalId: string }) => i.externalId === 'file/docs/runbook.md',
      ),
    ).toMatchObject({
      path: 'docs/runbook.md',
      revision: `blob:${blobSha('# Runbook\n\nRestart the payments gateway nightly at 03:00 UTC.')}`,
      originUri: 'https://github.com/acme/handbook/blob/main/docs/runbook.md',
    });

    // One file edited, one removed: the edit is a new blob sha, the removal is gone on a full walk.
    gh.files.set(
      'docs/runbook.md',
      '# Runbook\n\nRestart the payments gateway nightly at 02:00 UTC.',
    );
    gh.files.delete('docs/oncall.md');
    const second = await sync(conn.body.id, true);
    expect(second.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'full',
      seen: 1,
      changed: 1,
      gone: 1,
      ingested: 1,
    });
    expect(await docText('runbook.md')).toContain('02:00 UTC');
    const gone = await items(conn.body.id);
    expect(
      gone.body.items.find((i: { externalId: string }) => i.externalId === 'file/docs/oncall.md'),
    ).toMatchObject({
      state: 'gone',
    });
  }, 60_000);

  it('a repository that is not "owner/name", and a token the forge rejects, fail by name', async () => {
    const bad = await connect({
      packId: 'code_memory',
      sourceId: 'github_issues',
      vertical: 'code',
      config: { repo: 'not-a-repo' },
      credential: 'ghp_whatever',
    });
    const refused = await sync(bad.body.id);
    expect(refused.body.summary.status).toBe('failed');
    expect(refused.body.summary.error).toMatch(/config\.repo must be "owner\/name"/);

    const wrongToken = await connect({
      packId: 'code_memory',
      sourceId: 'github_issues',
      vertical: 'code',
      config: { repo: 'acme/handbook' },
      credential: 'ghp_not_a_real_token',
    });
    const rejected = await sync(wrongToken.body.id);
    expect(rejected.body.summary.status).toBe('failed');
    expect(rejected.body.summary.error).toMatch(/rejected \(401\)/);
    expect(rejected.body.summary.error).not.toContain('ghp_not_a_real_token');
  }, 60_000);
});

function seed(gh: FakeGithub): void {
  gh.issues = [
    {
      number: 12,
      title: 'Retries hammer the API on 429',
      body: 'We retry immediately, which makes the rate limit worse.',
      user: { login: 'gracehopper', name: 'Grace Hopper' },
      labels: ['bug'],
      createdAt: '2026-09-10T09:00:00Z',
      updatedAt: '2026-09-12T09:00:00Z',
      comments: [
        {
          id: 1,
          user: { login: 'linus', name: 'Linus Berg' },
          body: 'Agreed — we decided to back off exponentially.',
          createdAt: '2026-09-11T08:00:00Z',
        },
        {
          id: 2,
          user: { login: 'ci-bot', type: 'Bot' },
          body: 'Build passed.',
          createdAt: '2026-09-12T08:00:00Z',
        },
      ],
    },
    {
      number: 14,
      title: 'Honour Retry-After',
      body: 'Closes #12.',
      user: { login: 'linus', name: 'Linus Berg' },
      pull: true,
      createdAt: '2026-09-13T09:00:00Z',
      updatedAt: '2026-09-14T10:00:00Z',
    },
    {
      number: 15,
      title: 'Document the on-call rotation',
      body: 'The runbook says nothing about who is paged.',
      user: { login: 'gracehopper', name: 'Grace Hopper' },
      createdAt: '2026-09-14T11:00:00Z',
      updatedAt: '2026-09-14T11:00:00Z',
    },
    // Before `since`: never listed.
    {
      number: 3,
      title: 'Ancient',
      body: 'stale',
      user: { login: 'someone' },
      createdAt: '2026-05-01T09:00:00Z',
      updatedAt: '2026-05-01T09:00:00Z',
    },
  ];
  gh.files = new Map([
    ['README.md', '# Handbook\n\nOutside docs/.'],
    ['docs/runbook.md', '# Runbook\n\nRestart the payments gateway nightly at 03:00 UTC.'],
    ['docs/oncall.md', '# On-call\n\nGrace Hopper owns the payments rotation.'],
    ['docs/diagram.png', '\u0089PNG\r\n\u001a\n binary-ish'],
  ]);
}
