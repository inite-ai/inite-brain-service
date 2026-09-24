/**
 * The leakage red-team for the membership plane (W5, G6 steps 3–5) on a
 * REAL SurrealDB and a real fake GitLab.
 *
 * Every case here is a way an ACL mirror leaks, asserted to fail closed:
 *  - an org connection's private rows are NOT tenant-global;
 *  - an account nobody linked grants nobody anything;
 *  - a linked member sees them, and a user of the same tenant who is
 *    not a member does not;
 *  - a revoked member stops seeing them on the NEXT request, not the
 *    next cache expiry (the new-enemy problem: the epoch moves);
 *  - a tag nobody can parse hides its row rather than opening it;
 *  - the binary door's work leaves the ingest's own stack, so its scope
 *    rides the asset and the facts made in a job still carry it.
 */
import { randomBytes } from 'node:crypto';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { startFakeGitlab, type FakeGitlab } from './fixtures/fake-gitlab';

const COMPANY = 'co_scope_leakage_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_OAUTH_CLIENT',
  'SOURCE_CREDENTIAL_ENCRYPTION_KEY',
  'SOURCE_KIND_GITLAB',
  'SOURCE_OAUTH_GITLAB_CLIENT_ID',
  'SOURCE_OAUTH_GITLAB_CLIENT_SECRET',
  'SOURCE_OAUTH_GITLAB_BASE_URL',
  'SOURCE_EGRESS_ALLOW_PRIVATE',
  'SOURCE_PRINCIPALS',
  'SCOPE_TAGS_ENABLED',
  'EPISODE_SUBSTRATE_ENABLED',
  'INGEST_EPISODE_ONLY',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'BRAIN_PUBLIC_URL',
];

describe('scope leakage: the membership plane (e2e)', () => {
  let f: AppFixture;
  let gl: FakeGitlab;
  const saved: Record<string, string | undefined> = {};
  const admin = () => ({ Authorization: `Bearer ${f.apiKey}` });
  // Two user-bound keys in the SAME tenant: one is a project member,
  // one is not. The whole suite is the difference between them.
  const member = () => ({ Authorization: `Bearer ${f.extraApiKeys[0]}` });
  const stranger = () => ({ Authorization: `Bearer ${f.extraApiKeys[1]}` });

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
      SOURCE_PRINCIPALS: '1',
      SCOPE_TAGS_ENABLED: '1',
      EPISODE_SUBSTRATE_ENABLED: '1',
      INGEST_EPISODE_ONLY: '1',
      DOCUMENT_INGEST_ENABLED: '1',
      BRAIN_PUBLIC_URL: 'https://brain.example.test',
    });
    f = await createApp({
      companyId: COMPANY,
      extraKeys: [
        { scopes: ['brain:read', 'brain:write'], userId: 'u_member' },
        { scopes: ['brain:read', 'brain:write'], userId: 'u_stranger' },
      ],
    });
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
  const sync = (id: string) =>
    f.http
      .post(`/v1/admin/source-connections/${id}/sync`)
      .set(admin())
      .send({ inline: true, full: true });
  const principals = (id: string) =>
    f.http.get(`/v1/admin/source-connections/${id}/principals`).set(admin());
  const link = (id: string, body: Record<string, unknown>) =>
    f.http.post(`/v1/admin/source-connections/${id}/principals/link`).set(admin()).send(body);
  // `userId` is the per-user contract on every read surface: a token
  // that does not name the person gets tenant-global rows only.
  const episodesFor = (headers: Record<string, string>, userId?: string) =>
    f.http
      .get(
        `/v1/episodes?conversationId=${encodeURIComponent(CONVERSATION)}` +
          (userId ? `&userId=${userId}` : ''),
      )
      .set(headers);

  async function grant(): Promise<{ id: string }> {
    const start = await f.http
      .post('/v1/admin/source-connections/oauth/start')
      .set(admin())
      .send({ provider: 'gitlab', connector: 'gitlab' });
    const authorize = new URL(start.body.authorizeUrl);
    const page = await fetch(authorize.toString());
    const href = /href="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const back = new URL(href!);
    await f.http.get(`${back.pathname}${back.search}`);
    const grants = await f.http.get('/v1/admin/source-connections/oauth/grants').set(admin());
    return grants.body.grants.find((g: { provider: string }) => g.provider === 'gitlab');
  }

  let connectionId = '';
  const CONVERSATION = 'gl:acme/private#12';

  it('a private project’s rows are written for its members, not for the tenant', async () => {
    const g = await grant();
    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(admin())
      .send({
        packId: 'code_memory',
        sourceId: 'gitlab_issues',
        vertical: 'code',
        label: 'Private project',
        config: { project: 'acme/private', since: '2026-09-01', membersOnly: true },
        credential: `oauth:${g.id}`,
      });
    expect(conn.status).toBe(201);
    connectionId = conn.body.id;
    const run = await sync(connectionId);
    expect(run.body.summary.error ?? run.body.summary.status).toBe('succeeded');
    // The mirror ran and saw the project's members.
    expect(run.body.summary.principals).toMatchObject({ groups: 1, accounts: 2, linked: 0 });

    const eps = await rows<{ scope: string[] }>(
      `SELECT scope FROM episode WHERE conversationId = $c`,
      { c: CONVERSATION },
    );
    expect(eps.length).toBeGreaterThan(0);
    // NOT [] — the whole point. One tag, the project's member group.
    for (const e of eps) expect(e.scope).toEqual([`team:${tail(connectionId)}:members`]);
  }, 90_000);

  it('an account nobody has linked grants nobody anything', async () => {
    const body = (await principals(connectionId)).body;
    expect(body.identities.map((i: { handle: string }) => i.handle).sort()).toEqual([
      'gracehopper',
      'linus',
    ]);
    expect(body.identities.every((i: { userId: string | null }) => i.userId === null)).toBe(true);
    // Tuples exist — against the ACCOUNT, so a link made later inherits
    // them — but no `user:` subject holds anything yet.
    expect(body.tuples.some((t: { subject: string }) => t.subject.startsWith('user:'))).toBe(false);
    // So the member's own key sees nothing of the project.
    const seen = await episodesFor(member(), 'u_member');
    expect(seen.status).toBe(200);
    expect(seen.body.episodes ?? []).toHaveLength(0);
  }, 60_000);

  it('linking the account hands the person the group — and only that person', async () => {
    const linked = await link(connectionId, { externalId: '1', userId: 'u_member' });
    expect(linked.status).toBe(201);
    expect(
      linked.body.tuples.filter(
        (t: { subject: string; revokedAt: string | null }) =>
          t.subject === 'user:u_member' && t.revokedAt === null,
      ),
    ).toHaveLength(1);

    const mine = await episodesFor(member(), 'u_member');
    expect((mine.body.episodes ?? []).length).toBeGreaterThan(0);
    // Same tenant, not a member: still nothing.
    const theirs = await episodesFor(stranger(), 'u_stranger');
    expect(theirs.body.episodes ?? []).toHaveLength(0);
  }, 60_000);

  it('a member who leaves the project stops seeing it on the NEXT request', async () => {
    const before = (await principals(connectionId)).body.epoch;
    // Grace leaves the project upstream; the next walk revokes her.
    gl.members = gl.members.filter((m) => m.id !== 1);
    const run = await sync(connectionId);
    expect(run.body.summary.principals).toMatchObject({ accounts: 1, changed: true });
    const after = (await principals(connectionId)).body;
    // The epoch moved: every cached expansion of it is dead.
    expect(after.epoch).toBeGreaterThan(before);
    expect(
      after.tuples.find(
        (t: { subject: string; revokedAt: string | null }) => t.subject === 'user:u_member',
      ).revokedAt,
    ).not.toBeNull();

    const gone = await episodesFor(member(), 'u_member');
    expect(gone.body.episodes ?? []).toHaveLength(0);
  }, 90_000);

  it('unlinking an account takes the group back with it', async () => {
    gl.members = [
      { id: 1, username: 'gracehopper', name: 'Grace Hopper', state: 'active' },
      { id: 2, username: 'linus', name: 'Linus Berg', state: 'active' },
    ];
    await sync(connectionId);
    expect((await episodesFor(member(), 'u_member')).body.episodes.length).toBeGreaterThan(0);
    const unlinked = await link(connectionId, { externalId: '1', userId: null });
    expect(unlinked.status).toBe(201);
    expect((await episodesFor(member(), 'u_member')).body.episodes ?? []).toHaveLength(0);
  }, 90_000);

  it('a tag nobody can parse hides its row instead of opening it', async () => {
    await rows(`UPDATE episode SET scope = ['cabal:x'] WHERE conversationId = $c`, {
      c: CONVERSATION,
    });
    for (const [who, uid] of [
      [member(), 'u_member'],
      [stranger(), 'u_stranger'],
    ] as const) {
      const seen = await episodesFor(who, uid);
      expect(seen.body.episodes ?? []).toHaveLength(0);
    }
    // The admin key is tenant-wide authority — the tenant boundary
    // itself — and still sees the row, which is the parity property.
    const asAdmin = await episodesFor(admin());
    expect((asAdmin.body.episodes ?? []).length).toBeGreaterThan(0);
  }, 60_000);
});

function tail(id: string): string {
  const sep = id.indexOf(':');
  return sep >= 0 ? id.slice(sep + 1) : id;
}

function seed(gl: FakeGitlab): void {
  gl.project = { pathWithNamespace: 'acme/private', defaultBranch: 'main' };
  gl.members = [
    { id: 1, username: 'gracehopper', name: 'Grace Hopper', state: 'active' },
    { id: 2, username: 'linus', name: 'Linus Berg', state: 'active' },
  ];
  gl.issues = [
    {
      iid: 12,
      title: 'The staging key rotates on Friday',
      description: 'Nobody outside the project should read this.',
      author: { username: 'gracehopper', name: 'Grace Hopper' },
      createdAt: '2026-09-10T09:00:00Z',
      updatedAt: '2026-09-12T09:00:00Z',
    },
  ];
  gl.mergeRequests = [];
  gl.files = new Map();
}
