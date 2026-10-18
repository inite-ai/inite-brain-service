import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server playing GitLab for the forge suites: the OAuth
 * application (consent → code; a form token endpoint with PKCE and a
 * refresh token that ROTATES on use, as GitLab's does; `/api/v4/user`
 * as the identity) and the v4 API the connector speaks —
 * `/projects/:id`, `/issues` and `/merge_requests` (state / order /
 * updated_after / labels / paging, numbered SEPARATELY), their
 * `/notes` (system notes among them), `/repository/tree` and
 * `/repository/blobs/:sha`.
 *
 * Reached through SOURCE_OAUTH_GITLAB_BASE_URL under
 * SOURCE_EGRESS_ALLOW_PRIVATE.
 */
export interface GitlabFakeThread {
  iid: number;
  title: string;
  description?: string;
  state?: string;
  author?: { username: string; name?: string; bot?: boolean };
  labels?: string[];
  createdAt: string;
  updatedAt: string;
  notes?: Array<{
    id: number;
    author: { username: string; name?: string; bot?: boolean };
    body: string;
    createdAt: string;
    system?: boolean;
  }>;
}

export interface FakeGitlab {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  codes: Set<string>;
  tokens: Set<string>;
  /** Refresh tokens still unspent — GitLab rotates them on every use. */
  refreshTokens: Set<string>;
  identity: { username: string; name: string };
  project: { pathWithNamespace: string; defaultBranch: string };
  issues: GitlabFakeThread[];
  mergeRequests: GitlabFakeThread[];
  /** path → contents of the default branch's tree. */
  files: Map<string, string>;
}

export async function startFakeGitlab(): Promise<FakeGitlab> {
  let serial = 0;
  const f: FakeGitlab = {
    base: '',
    close: async () => undefined,
    calls: [],
    codes: new Set(),
    tokens: new Set(),
    refreshTokens: new Set(),
    identity: { username: 'gracehopper', name: 'Grace Hopper' },
    project: { pathWithNamespace: 'acme/handbook', defaultBranch: 'main' },
    issues: [],
    mergeRequests: [],
    files: new Map(),
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      f.calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        auth: req.headers.authorization ?? null,
        body,
      });
      try {
        route(f, req, res, body, () => `glpat_${String(++serial)}`);
      } catch (e) {
        json(res, 500, { message: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  f.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return f;
}

/** The id a blob is served under — content-addressed, like git's. */
export function blobId(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return `blob${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function route(
  f: FakeGitlab,
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  mint: () => string,
): void {
  const url = new URL(req.url ?? '/', f.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (p === '/oauth/authorize') return consent(f, url, res);
  if (m === 'POST' && p === '/oauth/token') return token(f, body, res, mint);
  if (m === 'POST' && p === '/oauth/revoke') {
    f.tokens.delete(new URLSearchParams(body).get('token') ?? '');
    return json(res, 200, {});
  }
  const token_ = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
  if (!f.tokens.has(token_)) return json(res, 401, { message: '401 Unauthorized' });
  if (p === '/api/v4/user')
    return json(res, 200, { id: 1, username: f.identity.username, name: f.identity.name });
  const project = `/api/v4/projects/${encodeURIComponent(f.project.pathWithNamespace)}`;
  if (p !== project && !p.startsWith(`${project}/`))
    return json(res, 404, { message: '404 Project Not Found' });
  const rest = p.slice(project.length);
  if (rest === '')
    return json(res, 200, {
      id: 7,
      path_with_namespace: f.project.pathWithNamespace,
      default_branch: f.project.defaultBranch,
      web_url: `https://gitlab.com/${f.project.pathWithNamespace}`,
    });
  return projectRoute(f, rest, url, res);
}

function projectRoute(f: FakeGitlab, rest: string, url: URL, res: ServerResponse): void {
  for (const [segment, list] of [
    ['/issues', f.issues],
    ['/merge_requests', f.mergeRequests],
  ] as Array<[string, GitlabFakeThread[]]>) {
    if (rest === segment) return listThreads(f, segment, list, url, res);
    const one = new RegExp(`^${segment}/(\\d+)$`).exec(rest);
    if (one) {
      const t = list.find((i) => i.iid === Number(one[1]));
      return t
        ? json(res, 200, threadJson(f, segment, t))
        : json(res, 404, { message: '404 Not found' });
    }
    const notes = new RegExp(`^${segment}/(\\d+)/notes$`).exec(rest);
    if (notes) {
      const t = list.find((i) => i.iid === Number(notes[1]));
      return json(
        res,
        200,
        (t?.notes ?? []).map((n) => ({
          id: n.id,
          author: n.author,
          body: n.body,
          system: n.system ?? false,
          created_at: n.createdAt,
        })),
      );
    }
  }
  if (rest === '/repository/tree') return tree(f, url, res);
  const blob = /^\/repository\/blobs\/([^/]+)$/.exec(rest);
  if (blob) {
    const found = [...f.files.values()].find((c) => blobId(c) === decodeURIComponent(blob[1]!));
    if (found === undefined) return json(res, 404, { message: '404 Blob Not Found' });
    return json(res, 200, {
      sha: blobId(found),
      encoding: 'base64',
      size: Buffer.byteLength(found, 'utf8'),
      content: Buffer.from(found, 'utf8').toString('base64'),
    });
  }
  return json(res, 404, { message: `no route ${rest}` });
}

function consent(f: FakeGitlab, url: URL, res: ServerResponse): void {
  const back = new URL(url.searchParams.get('redirect_uri') ?? '');
  const code = `gl_code_${String(f.codes.size + 1)}`;
  f.codes.add(code);
  back.searchParams.set('code', code);
  back.searchParams.set('state', url.searchParams.get('state') ?? '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><body><h2>Fake GitLab (scope ${escapeHtml(url.searchParams.get('scope') ?? '')})</h2><p><a id="allow" href="${escapeHtml(back.toString())}">Authorize</a></p></body></html>`,
  );
}

function token(f: FakeGitlab, body: string, res: ServerResponse, mint: () => string): void {
  const params = new URLSearchParams(body);
  if (params.get('client_id') !== 'gl-client' || params.get('client_secret') !== 'gl-secret')
    return json(res, 401, { error: 'invalid_client' });
  if (params.get('grant_type') === 'refresh_token') {
    // GitLab spends a refresh token on first use: a second attempt with
    // the same one is refused.
    if (!f.refreshTokens.delete(params.get('refresh_token') ?? ''))
      return json(res, 400, { error: 'invalid_grant' });
  } else {
    if (!f.codes.delete(params.get('code') ?? ''))
      return json(res, 400, { error: 'invalid_grant' });
    if (!params.get('code_verifier')) return json(res, 400, { error: 'invalid_request' });
  }
  const access = mint();
  const refresh = `${access}_r`;
  f.tokens.add(access);
  f.refreshTokens.add(refresh);
  return json(res, 200, {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: 7200,
    scope: 'read_api read_user',
  });
}

function listThreads(
  f: FakeGitlab,
  segment: string,
  list: GitlabFakeThread[],
  url: URL,
  res: ServerResponse,
): void {
  const after = url.searchParams.get('updated_after');
  const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
  const per = Number(url.searchParams.get('per_page') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
  const all = list
    .filter((i) => !after || i.updatedAt >= after)
    .filter((i) => labels.every((l) => (i.labels ?? []).includes(l)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return json(
    res,
    200,
    all.slice((page - 1) * per, page * per).map((t) => threadJson(f, segment, t)),
  );
}

function threadJson(f: FakeGitlab, segment: string, t: GitlabFakeThread): Record<string, unknown> {
  return {
    id: t.iid * 100,
    iid: t.iid,
    project_id: 7,
    title: t.title,
    description: t.description ?? null,
    state: t.state ?? 'opened',
    author: t.author ?? { username: 'someone' },
    labels: t.labels ?? [],
    user_notes_count: (t.notes ?? []).filter((n) => n.system !== true).length,
    web_url: `https://gitlab.com/${f.project.pathWithNamespace}/-/${segment.slice(1)}/${String(t.iid)}`,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

function tree(f: FakeGitlab, url: URL, res: ServerResponse): void {
  if ((url.searchParams.get('ref') ?? '') !== f.project.defaultBranch)
    return json(res, 404, { message: '404 Tree Not Found' });
  const per = Number(url.searchParams.get('per_page') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
  const all = [...f.files.entries()].map(([path, content]) => ({
    id: blobId(content),
    name: path.split('/').pop(),
    type: 'blob',
    path,
    mode: '100644',
  }));
  return json(res, 200, all.slice((page - 1) * per, page * per));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
