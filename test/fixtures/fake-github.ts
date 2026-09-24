import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server playing GitHub for the forge-connector suites:
 * the OAuth app (consent → code; a FORM token endpoint that answers
 * JSON only when asked for it, as github.com does; `/user` as the
 * identity) and the REST API the connector speaks — `/repos/:o/:r`,
 * `/issues` (state / sort / since / labels / paging, pull requests
 * among them), `/issues/:n`, `/issues/:n/comments`, `/git/trees/:ref`
 * and `/git/blobs/:sha`.
 *
 * Reached through SOURCE_OAUTH_GITHUB_BASE_URL under
 * SOURCE_EGRESS_ALLOW_PRIVATE.
 */
export interface GithubFakeIssue {
  number: number;
  title: string;
  body?: string;
  state?: string;
  user?: { login: string; name?: string; type?: string };
  labels?: string[];
  createdAt: string;
  updatedAt: string;
  pull?: boolean;
  comments?: Array<{
    id: number;
    user: { login: string; name?: string; type?: string };
    body: string;
    createdAt: string;
  }>;
}

export interface FakeGithub {
  base: string;
  close(): Promise<void>;
  calls: Array<{
    method: string;
    path: string;
    auth: string | null;
    accept: string | null;
    body: string;
  }>;
  codes: Set<string>;
  tokens: Set<string>;
  identity: { login: string; name: string };
  repo: { fullName: string; defaultBranch: string };
  issues: GithubFakeIssue[];
  /** path → contents of the default branch's tree. */
  files: Map<string, string>;
}

export async function startFakeGithub(): Promise<FakeGithub> {
  let serial = 0;
  const f: FakeGithub = {
    base: '',
    close: async () => undefined,
    calls: [],
    codes: new Set(),
    tokens: new Set(),
    identity: { login: 'gracehopper', name: 'Grace Hopper' },
    repo: { fullName: 'acme/handbook', defaultBranch: 'main' },
    issues: [],
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
        accept: (req.headers.accept as string) ?? null,
        body,
      });
      try {
        route(f, req, res, body, () => `ghs_${++serial}`);
      } catch (e) {
        json(res, 500, { message: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return f;
}

/** The sha a blob is served under — content-addressed, like git's. */
export function blobSha(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return `sha${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function route(
  f: FakeGithub,
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  mint: () => string,
): void {
  const url = new URL(req.url ?? '/', f.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (p === '/login/oauth/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    const code = `gh_code_${f.codes.size + 1}`;
    f.codes.add(code);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body><h2>Fake GitHub (scope ${escapeHtml(url.searchParams.get('scope') ?? '')})</h2><p><a id="allow" href="${escapeHtml(back.toString())}">Allow</a></p></body></html>`,
    );
    return;
  }
  if (m === 'POST' && p === '/login/oauth/access_token') {
    const params = new URLSearchParams(body);
    if (params.get('client_id') !== 'gh-client' || params.get('client_secret') !== 'gh-secret')
      return json(res, 200, { error: 'incorrect_client_credentials' });
    if (!f.codes.has(params.get('code') ?? ''))
      return json(res, 200, { error: 'bad_verification_code' });
    f.codes.delete(params.get('code')!);
    const token = mint();
    f.tokens.add(token);
    // github.com answers form-encoded UNLESS the caller asks for JSON.
    if (!(req.headers.accept ?? '').includes('application/json')) {
      res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
      res.end(`access_token=${token}&scope=repo&token_type=bearer`);
      return;
    }
    return json(res, 200, { access_token: token, token_type: 'bearer', scope: 'repo,read:user' });
  }
  const token = (req.headers.authorization ?? '').replace(/^(Bearer|token) /i, '');
  if (!f.tokens.has(token)) return json(res, 401, { message: 'Bad credentials' });
  if (p === '/user')
    return json(res, 200, { login: f.identity.login, name: f.identity.name, id: 1 });
  const repo = `/repos/${f.repo.fullName}`;
  if (p === repo)
    return json(res, 200, { full_name: f.repo.fullName, default_branch: f.repo.defaultBranch });
  if (p === `${repo}/issues`) return issuesList(f, url, res);
  const one = new RegExp(`^${repo}/issues/(\\d+)$`).exec(p);
  if (one) {
    const issue = f.issues.find((i) => i.number === Number(one[1]));
    return issue ? json(res, 200, issueJson(f, issue)) : json(res, 404, { message: 'Not Found' });
  }
  const comments = new RegExp(`^${repo}/issues/(\\d+)/comments$`).exec(p);
  if (comments) {
    const issue = f.issues.find((i) => i.number === Number(comments[1]));
    return json(
      res,
      200,
      (issue?.comments ?? []).map((c) => ({
        id: c.id,
        user: c.user,
        body: c.body,
        created_at: c.createdAt,
      })),
    );
  }
  const tree = new RegExp(`^${repo}/git/trees/([^/]+)$`).exec(p);
  if (tree) {
    if (decodeURIComponent(tree[1]!) !== f.repo.defaultBranch)
      return json(res, 404, { message: 'Not Found' });
    return json(res, 200, {
      sha: 'tree-sha',
      truncated: false,
      tree: [...f.files.entries()].map(([path, content]) => ({
        path,
        mode: '100644',
        type: 'blob',
        sha: blobSha(content),
        size: Buffer.byteLength(content, 'utf8'),
      })),
    });
  }
  const blob = new RegExp(`^${repo}/git/blobs/([^/]+)$`).exec(p);
  if (blob) {
    const found = [...f.files.values()].find((c) => blobSha(c) === decodeURIComponent(blob[1]!));
    if (found === undefined) return json(res, 404, { message: 'Not Found' });
    return json(res, 200, {
      sha: blobSha(found),
      encoding: 'base64',
      size: Buffer.byteLength(found, 'utf8'),
      content: Buffer.from(found, 'utf8').toString('base64'),
    });
  }
  return json(res, 404, { message: `no route ${p}` });
}

function issuesList(f: FakeGithub, url: URL, res: ServerResponse): void {
  const since = url.searchParams.get('since');
  const labels = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const page = Number(url.searchParams.get('page') ?? 1);
  const all = f.issues
    .filter((i) => !since || i.updatedAt >= since)
    .filter((i) => labels.every((l) => (i.labels ?? []).includes(l)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return json(
    res,
    200,
    all.slice((page - 1) * per, page * per).map((i) => issueJson(f, i)),
  );
}

function issueJson(f: FakeGithub, i: GithubFakeIssue): Record<string, unknown> {
  const kind = i.pull ? 'pull' : 'issues';
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? null,
    state: i.state ?? 'open',
    user: i.user ?? { login: 'someone' },
    labels: (i.labels ?? []).map((name) => ({ name })),
    comments: i.comments?.length ?? 0,
    html_url: `https://github.com/${f.repo.fullName}/${kind}/${String(i.number)}`,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    ...(i.pull ? { pull_request: { url: `https://api.github.com/x/${String(i.number)}` } } : {}),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
