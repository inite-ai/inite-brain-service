/**
 * The other forge as memory, end to end on a REAL SurrealDB (W4.9),
 * against the fake GitLab:
 *  - the OAuth application (PKCE, a refresh token that rotates on use,
 *    the username as the account);
 *  - issues AND merge requests as conversations: two separate listings
 *    under one cap, an issue #5 kept apart from a merge request !5, the
 *    description and every note as turns through the mention door, the
 *    activity feed dropped, `includeMergeRequests: false` and a label
 *    filter narrowing the walk, an incremental run listing from the
 *    checkpoint and a new note bringing the whole thread back;
 *  - the docs of the tree as documents: the recursive listing, the blob
 *    id the revision, `paths` and the media table deciding, a changed
 *    file re-read and a removed one gone on a full walk.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { blobId, startFakeGitlab, type FakeGitlab } from './fixtures/fake-gitlab';

const COMPANY = 'co_gitlab_vendors_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_GITLAB',
  'SOURCE_OAUTH_GITLAB_CLIENT_ID',
  'SOURCE_OAUTH_GITLAB_CLIENT_SECRET',
  'SOURCE_OAUTH_GITLAB_BASE_URL',
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

describe('forge: gitlab (e2e)', () => {
  let f: AppFixture;
  let gl: FakeGitlab;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    gl = await startFakeGitlab();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_OAUTH_CLIENT: '1',
      SOURCE_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SOURCE_KIND_GITLAB: '1',
      SOURCE_OAUTH_GITLAB_CLIENT_ID: 'gl-client',
      SOURCE_OAUTH_GITLAB_CLIENT_SECRET: 'gl-secret',
      SOURCE_OAUTH_GITLAB_BASE_URL: gl.base,
      SOURCE_EGRESS_ALLOW_PRIVATE: '1',
      EPISODE_SUBSTRATE_ENABLED: '1',
      INGEST_EPISODE_ONLY: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({ companyId: COMPANY });
    seed(gl);
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await gl.close();
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
      .send({ provider: 'gitlab', connector: 'gitlab' });
    expect(start.status).toBe(201);
    const authorize = new URL(start.body.authorizeUrl);
    // PKCE: GitLab is asked with a challenge, and the exchange sends the verifier.
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const page = await fetch(authorize.toString());
    const href = /href="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const back = new URL(href!);
    await f.http.get(`${back.pathname}${back.search}`);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(auth());
    return grants.body.grants.find((g: { provider: string }) => g.provider === 'gitlab');
  }

  it('issues and merge requests are two listings and two threads, with the activity feed left out', async () => {
    const catalog = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    expect(
      catalog.body.sources
        .filter((s: { packId: string }) => s.packId === 'code_memory')
        .map((s: { sourceId: string; availability: string }) => `${s.sourceId}:${s.availability}`),
    ).toEqual(expect.arrayContaining(['gitlab_issues:ready', 'gitlab_docs:ready']));
    const g = await grant();
    expect(g).toMatchObject({ account: 'gracehopper', refreshable: true });
    const exchange = gl.calls.find((c) => c.path === '/oauth/token')!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBeTruthy();

    const conn = await connect({
      packId: 'code_memory',
      sourceId: 'gitlab_issues',
      vertical: 'code',
      label: 'Handbook threads',
      config: { project: 'acme/handbook', since: '2026-09-01' },
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
    // Issue #12 (description + 2 real notes, 1 system note dropped),
    // issue #5 (description), merge request !5 (description).
    expect(eps).toHaveLength(5);
    const thread = eps.filter((e) => e.conversationId === 'gl:acme/handbook#12');
    expect(thread.map((e) => e.messageId)).toEqual(['issue-12', 'note-91', 'note-93']);
    expect(thread[0]!.text).toContain('Grace Hopper: Issue #12: Retries hammer the API on 429');
    expect(thread[1]!.text).toBe('Linus Berg: Agreed — we decided to back off exponentially.');
    // The two #5s are different threads, not one.
    expect(eps.find((e) => e.conversationId === 'gl:acme/handbook#5')?.text).toContain(
      'Issue #5: Document the on-call rotation',
    );
    expect(eps.find((e) => e.conversationId === 'gl:acme/handbook!5')?.text).toContain(
      'MR !5: Honour Retry-After',
    );
    const catalogue = await items(conn.body.id);
    expect(
      catalogue.body.items.find((i: { externalId: string }) => i.externalId === 'mr/5'),
    ).toMatchObject({
      title: '!5 Honour Retry-After',
      path: 'mr/5',
      revision: 'u:2026-09-14T10:00:00Z',
      originUri: 'https://gitlab.com/acme/handbook/-/merge_requests/5',
    });

    // Nothing changed: the incremental run lists from the checkpoint.
    const again = await sync(conn.body.id);
    expect(again.body.summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      ingested: 0,
    });
    const listed = new URL(
      gl.calls.filter((c) => c.path.includes('/issues?')).at(-1)!.path,
      gl.base,
    );
    expect(Date.parse(listed.searchParams.get('updated_after')!)).toBeGreaterThan(
      Date.parse('2026-09-01'),
    );

    // A new note moves updated_at: the whole thread lands again.
    const issue12 = gl.issues.find((i) => i.iid === 12)!;
    issue12.notes!.push({
      id: 94,
      author: { username: 'gracehopper', name: 'Grace Hopper' },
      body: 'Shipped in 2.4.1.',
      createdAt: new Date().toISOString(),
    });
    issue12.updatedAt = new Date().toISOString();
    const third = await sync(conn.body.id);
    expect(third.body.summary).toMatchObject({ status: 'succeeded', changed: 1, ingested: 1 });
    const after = await episodesOf(conn.body.recorder);
    expect(after.find((e) => e.messageId === 'note-94')?.text).toBe(
      'Grace Hopper: Shipped in 2.4.1.',
    );
  }, 60_000);

  it('a label filter and includeMergeRequests: false narrow what is read', async () => {
    const g = await grant();
    const conn = await connect({
      packId: 'code_memory',
      sourceId: 'gitlab_issues',
      vertical: 'code',
      config: {
        project: 'acme/handbook',
        since: '2026-09-01',
        labels: ['bug'],
        includeMergeRequests: false,
      },
      credential: `oauth:${g.id}`,
    });
    const mrCalls = () => gl.calls.filter((c) => c.path.includes('/merge_requests?')).length;
    const before = mrCalls();
    const run = await sync(conn.body.id);
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 1, ingested: 1 });
    const catalogue = await items(conn.body.id);
    expect(catalogue.body.items.map((i: { externalId: string }) => i.externalId)).toEqual([
      'issue/12',
    ]);
    // The merge-request listing was never asked for in this run.
    expect(mrCalls()).toBe(before);
  }, 60_000);

  it('the docs of the tree are documents: the blob id is the revision, a removed file is gone on a full walk', async () => {
    const g = await grant();
    const conn = await connect({
      packId: 'code_memory',
      sourceId: 'gitlab_docs',
      vertical: 'code',
      label: 'Handbook docs',
      config: { project: 'acme/handbook', paths: ['docs/'] },
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
      revision: `blob:${blobId('# Runbook\n\nRestart the payments gateway nightly at 03:00 UTC.')}`,
      originUri: 'https://gitlab.com/acme/handbook/-/blob/main/docs/runbook.md',
    });

    gl.files.set(
      'docs/runbook.md',
      '# Runbook\n\nRestart the payments gateway nightly at 02:00 UTC.',
    );
    gl.files.delete('docs/oncall.md');
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
    ).toMatchObject({ state: 'gone' });
  }, 60_000);

  it('a project that is not a path, and a token the instance rejects, fail by name', async () => {
    const bad = await connect({
      packId: 'code_memory',
      sourceId: 'gitlab_issues',
      vertical: 'code',
      config: { project: 'handbook' },
      credential: 'glpat-whatever',
    });
    const refused = await sync(bad.body.id);
    expect(refused.body.summary.status).toBe('failed');
    expect(refused.body.summary.error).toMatch(/config\.project must be "group\/name"/);

    const wrongToken = await connect({
      packId: 'code_memory',
      sourceId: 'gitlab_issues',
      vertical: 'code',
      config: { project: 'acme/handbook' },
      credential: 'glpat-not-a-real-token',
    });
    const rejected = await sync(wrongToken.body.id);
    expect(rejected.body.summary.status).toBe('failed');
    expect(rejected.body.summary.error).toMatch(/rejected \(401\)/);
    expect(rejected.body.summary.error).not.toContain('glpat-not-a-real-token');
  }, 60_000);
});

function seed(gl: FakeGitlab): void {
  gl.issues = [
    {
      iid: 12,
      title: 'Retries hammer the API on 429',
      description: 'We retry immediately, which makes the rate limit worse.',
      author: { username: 'gracehopper', name: 'Grace Hopper' },
      labels: ['bug'],
      createdAt: '2026-09-10T09:00:00Z',
      updatedAt: '2026-09-12T09:00:00Z',
      notes: [
        {
          id: 91,
          author: { username: 'linus', name: 'Linus Berg' },
          body: 'Agreed — we decided to back off exponentially.',
          createdAt: '2026-09-11T08:00:00Z',
        },
        {
          id: 92,
          author: { username: 'linus', name: 'Linus Berg' },
          body: 'changed the description',
          system: true,
          createdAt: '2026-09-11T08:05:00Z',
        },
        {
          id: 93,
          author: { username: 'release_bot', bot: true },
          body: 'Pipeline #4 passed.',
          createdAt: '2026-09-12T08:00:00Z',
        },
      ],
    },
    {
      iid: 5,
      title: 'Document the on-call rotation',
      description: 'The runbook says nothing about who is paged.',
      author: { username: 'gracehopper', name: 'Grace Hopper' },
      createdAt: '2026-09-14T11:00:00Z',
      updatedAt: '2026-09-14T11:00:00Z',
    },
    // Before `since`: never listed.
    {
      iid: 2,
      title: 'Ancient',
      description: 'stale',
      author: { username: 'someone' },
      createdAt: '2026-05-01T09:00:00Z',
      updatedAt: '2026-05-01T09:00:00Z',
    },
  ];
  gl.mergeRequests = [
    {
      iid: 5,
      title: 'Honour Retry-After',
      description: 'Closes #12.',
      author: { username: 'linus', name: 'Linus Berg' },
      createdAt: '2026-09-13T09:00:00Z',
      updatedAt: '2026-09-14T10:00:00Z',
    },
  ];
  gl.files = new Map([
    ['README.md', '# Handbook\n\nOutside docs/.'],
    ['docs/runbook.md', '# Runbook\n\nRestart the payments gateway nightly at 03:00 UTC.'],
    ['docs/oncall.md', '# On-call\n\nGrace Hopper owns the payments rotation.'],
    ['docs/diagram.png', '\u0089PNG\r\n\u001a\n binary-ish'],
  ]);
}
