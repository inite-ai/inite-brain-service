import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server that plays Google (OAuth + Drive v3), Microsoft
 * (OAuth + Graph) and Dropbox (OAuth + API v2) for the cloud-connector
 * and OAuth suites — the SOURCE_OAUTH_<P>_BASE_URL override points every
 * URL of a provider here (paths kept), under SOURCE_EGRESS_ALLOW_PRIVATE.
 *
 * Deliberately small and mutable: tests edit `drive`, `dropbox` and
 * `graph` between runs to make files appear, change and vanish, and
 * read `calls` to assert what the brain asked for. Every API route
 * demands `authorization: Bearer <a token this server issued>`.
 */
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  content: string | Buffer;
  modified: string;
  /** Google: the parent folder id; Graph/Dropbox: unused. */
  parent?: string;
  /** Google: a native document (no bytes; exported). */
  native?: boolean;
  trashed?: boolean;
}

export interface FakeCloud {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  /** Tokens this server minted and accepts. */
  tokens: Set<string>;
  /** Mint a new access token (and remember it). */
  mint(): string;
  /** Make the given access token invalid (expired at the provider). */
  invalidate(token: string): void;
  /** What the next token exchange / refresh answers, or a failure. */
  nextToken: { expiresIn?: number; refresh?: boolean; fail?: string } | null;
  /** The last authorization code this server will accept. */
  codes: Map<string, { verifierChallenge?: string }>;
  google: {
    /** The standing tree: every live file, by parent folder id ('root' = My Drive, 'shared' = shared with me). */
    files: FakeFile[];
    folders: Array<{ id: string; name: string; parent: string }>;
    /** What the next `changes.list` answers (then cleared). */
    changes: Array<{ fileId: string; removed?: boolean; file?: FakeFile }>;
    startPageToken: string;
  };
  dropbox: {
    /** The standing folder (a full `list_folder` returns it; downloads read it). */
    all: FakeFile[];
    /** What the next `list_folder/continue` answers (then cleared). */
    changed: FakeFile[];
    deleted: string[];
    cursorSerial: number;
  };
  graph: {
    /** The standing folder (a fresh delta returns it; downloads read it). */
    all: FakeFile[];
    /** What the next token'd delta answers (then cleared). */
    changed: FakeFile[];
    deleted: string[];
    deltaSerial: number;
    /** Answer the next token'd delta with 410 (resync required). */
    expireDelta?: boolean;
  };
  /** Identity answers. */
  identity: { email: string };
}

export async function startFakeCloud(): Promise<FakeCloud> {
  let serial = 0;
  const cloud: FakeCloud = {
    base: '',
    close: async () => undefined,
    calls: [],
    tokens: new Set(),
    mint() {
      const t = `tok_${++serial}`;
      cloud.tokens.add(t);
      return t;
    },
    invalidate(t) {
      cloud.tokens.delete(t);
    },
    nextToken: null,
    codes: new Map(),
    google: { files: [], folders: [], changes: [], startPageToken: '100' },
    dropbox: { all: [], changed: [], deleted: [], cursorSerial: 0 },
    graph: { all: [], changed: [], deleted: [], deltaSerial: 0 },
    identity: { email: 'owner@example.test' },
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const auth = req.headers.authorization ?? null;
      cloud.calls.push({ method: req.method ?? '', path: req.url ?? '', auth, body });
      try {
        route(cloud, req, res, body);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  cloud.base = `http://127.0.0.1:${port}`;
  cloud.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return cloud;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

function bytes(res: ServerResponse, content: string | Buffer, type: string): void {
  res.writeHead(200, { 'content-type': type });
  res.end(content);
}

function bearerOk(cloud: FakeCloud, req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') && cloud.tokens.has(h.slice(7));
}

function tokenAnswer(cloud: FakeCloud, res: ServerResponse, params: URLSearchParams): void {
  const spec = cloud.nextToken ?? {};
  cloud.nextToken = null;
  if (spec.fail) return json(res, 400, { error: spec.fail, error_description: 'as told' });
  const grant = params.get('grant_type');
  if (grant === 'authorization_code') {
    const code = params.get('code') ?? '';
    if (!cloud.codes.has(code))
      return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
    if (!params.get('code_verifier'))
      return json(res, 400, { error: 'invalid_request', error_description: 'no verifier' });
    cloud.codes.delete(code);
  } else if (grant === 'refresh_token') {
    if (!params.get('refresh_token')?.startsWith('rt_'))
      return json(res, 400, { error: 'invalid_grant', error_description: 'bad refresh token' });
  } else {
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  const access = cloud.mint();
  return json(res, 200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: spec.expiresIn ?? 3600,
    ...(spec.refresh === false ? {} : { refresh_token: `rt_${access}` }),
    scope: params.get('scope') ?? '',
  });
}

function route(cloud: FakeCloud, req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', cloud.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  // ── consent pages (google / microsoft / dropbox): a button that sends the browser back with a code ──
  if (
    m === 'GET' &&
    (p === '/o/oauth2/v2/auth' ||
      p === '/common/oauth2/v2.0/authorize' ||
      p === '/oauth2/authorize')
  ) {
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (!url.searchParams.get('code_challenge'))
      return json(res, 400, { error: 'no PKCE challenge' });
    const code = `code_${++cloud.dropbox.cursorSerial}`;
    cloud.codes.set(code, {});
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body style="font:16px system-ui;margin:3rem"><h2>Fake provider</h2>` +
        `<p>brain asks for: <code>${escapeHtml(url.searchParams.get('scope') ?? '')}</code></p>` +
        `<p><a id="allow" href="${escapeHtml(back.toString())}" style="padding:.5rem 1rem;background:#1a73e8;color:#fff;border-radius:4px;text-decoration:none">Allow</a></p></body></html>`,
    );
    return;
  }
  // ── token endpoints (google / microsoft / dropbox) ──
  if (
    m === 'POST' &&
    (p === '/token' || p === '/common/oauth2/v2.0/token' || p === '/oauth2/token')
  ) {
    return tokenAnswer(cloud, res, new URLSearchParams(body));
  }
  if (m === 'POST' && p === '/revoke') return json(res, 200, {});
  if (!p.startsWith('/dl/') && !bearerOk(cloud, req))
    return json(res, 401, { error: { message: 'invalid credentials' } });
  // ── identity ──
  if (p === '/oauth2/v3/userinfo') return json(res, 200, { email: cloud.identity.email, sub: '1' });
  if (p === '/v1.0/me') return json(res, 200, { userPrincipalName: cloud.identity.email, id: '1' });
  if (p === '/2/users/get_current_account')
    return json(res, 200, { email: cloud.identity.email, account_id: 'dbid:1' });
  if (m === 'POST' && p === '/2/auth/token/revoke') return json(res, 200, null);
  // ── Google Drive v3 ──
  if (p === '/drive/v3/files' && m === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const shared = /sharedWithMe = true/.test(q);
    const files = [
      ...cloud.google.folders
        .filter((f) => f.parent === parent)
        .map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [f.parent],
        })),
      ...cloud.google.files
        .filter((f) => (shared ? f.parent === 'shared' : f.parent === parent))
        .map(driveFile),
    ];
    return json(res, 200, { files });
  }
  if (p === '/drive/v3/changes/startPageToken')
    return json(res, 200, { startPageToken: cloud.google.startPageToken });
  if (p === '/drive/v3/changes') {
    const changes = cloud.google.changes.map((c) => ({
      fileId: c.fileId,
      removed: c.removed ?? false,
      ...(c.file ? { file: driveFile(c.file) } : {}),
    }));
    cloud.google.changes = [];
    cloud.google.startPageToken = String(Number(cloud.google.startPageToken) + 1);
    return json(res, 200, { changes, newStartPageToken: cloud.google.startPageToken });
  }
  let mm = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p);
  if (mm) {
    const f = cloud.google.files.find((x) => x.id === decodeURIComponent(mm![1]!));
    if (!f) return json(res, 404, { error: 'no such file' });
    const mime = url.searchParams.get('mimeType') ?? 'text/plain';
    return bytes(
      res,
      mime.startsWith('text/') ? f.content : Buffer.from(`OOXML:${f.content}`),
      mime,
    );
  }
  mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
  if (mm && url.searchParams.get('alt') === 'media') {
    const f = cloud.google.files.find((x) => x.id === decodeURIComponent(mm![1]!));
    if (!f) return json(res, 404, { error: 'no such file' });
    return bytes(res, f.content, f.mimeType);
  }
  // ── Dropbox v2 ──
  if (m === 'POST' && p === '/2/files/list_folder') {
    const arg = JSON.parse(body || '{}') as { path?: string };
    const prefix = (arg.path ?? '').toLowerCase();
    const entries = cloud.dropbox.all
      .filter((f) => f.id.toLowerCase().startsWith(prefix))
      .map(dropboxFile);
    return json(res, 200, {
      entries,
      cursor: `cur_${++cloud.dropbox.cursorSerial}`,
      has_more: false,
    });
  }
  if (m === 'POST' && p === '/2/files/list_folder/continue') {
    const arg = JSON.parse(body || '{}') as { cursor?: string };
    if (arg.cursor === 'reset-me')
      return json(res, 409, { error_summary: 'reset/..', error: { '.tag': 'reset' } });
    const entries = [
      ...cloud.dropbox.changed.map(dropboxFile),
      ...cloud.dropbox.deleted.map((path) => ({
        '.tag': 'deleted',
        name: path.slice(path.lastIndexOf('/') + 1),
        path_lower: path.toLowerCase(),
        path_display: path,
      })),
    ];
    cloud.dropbox.changed = [];
    cloud.dropbox.deleted = [];
    return json(res, 200, {
      entries,
      cursor: `cur_${++cloud.dropbox.cursorSerial}`,
      has_more: false,
    });
  }
  if (m === 'POST' && p === '/2/files/download') {
    const arg = JSON.parse((req.headers['dropbox-api-arg'] as string | undefined) ?? '{}') as {
      path?: string;
    };
    const f = cloud.dropbox.all.find((x) => x.id.toLowerCase() === (arg.path ?? '').toLowerCase());
    if (!f) return json(res, 409, { error_summary: 'path/not_found' });
    return bytes(res, f.content, 'application/octet-stream');
  }
  // ── Microsoft Graph ──
  mm = /^\/v1\.0\/(me\/drive|drives\/[^/]+|sites\/[^/]+\/drive)\/root(?::\/[^:]*:)?\/delta$/.exec(
    p,
  );
  if (mm) {
    const token = url.searchParams.get('token');
    if (token && cloud.graph.expireDelta) {
      cloud.graph.expireDelta = false;
      return json(res, 410, { error: { code: 'resyncRequired' } });
    }
    const value = token
      ? [
          ...cloud.graph.changed.map(graphItem),
          ...cloud.graph.deleted.map((id) => ({ id, name: id, deleted: { state: 'deleted' } })),
        ]
      : cloud.graph.all.map(graphItem);
    if (token) {
      cloud.graph.changed = [];
      cloud.graph.deleted = [];
    }
    const deltaLink = `${cloud.base}${p}?token=d${++cloud.graph.deltaSerial}`;
    return json(res, 200, { value, '@odata.deltaLink': deltaLink });
  }
  mm = /^\/v1\.0\/(?:me\/drive|drives\/[^/]+|sites\/[^/]+\/drive)\/items\/([^/]+)$/.exec(p);
  if (mm) {
    const id = decodeURIComponent(mm[1]!);
    const f = cloud.graph.all.find((x) => x.id === id);
    if (!f) return json(res, 404, { error: { code: 'itemNotFound' } });
    return json(res, 200, {
      id,
      name: f.name,
      file: { mimeType: f.mimeType },
      '@microsoft.graph.downloadUrl': `${cloud.base}/dl/${encodeURIComponent(id)}`,
    });
  }
  mm = /^\/dl\/([^/]+)$/.exec(p);
  if (mm) {
    // A pre-authenticated download: the bearer must NOT be here.
    if (req.headers.authorization)
      return json(res, 400, { error: 'bearer sent to a download url' });
    const f = cloud.graph.all.find((x) => x.id === decodeURIComponent(mm![1]!));
    if (!f) return json(res, 404, {});
    return bytes(res, f.content, f.mimeType);
  }
  return json(res, 404, { error: `no route ${m} ${p}` });
}

function driveFile(f: FakeFile): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modified,
    ...(f.native
      ? { version: '3' }
      : { size: String(Buffer.byteLength(f.content)), md5Checksum: `md5-${f.id}-${f.modified}` }),
    parents: [f.parent ?? 'root'],
    trashed: f.trashed ?? false,
    webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
  };
}

function dropboxFile(f: FakeFile): Record<string, unknown> {
  return {
    '.tag': 'file',
    id: `id:${f.id}`,
    name: f.name,
    path_lower: f.id.toLowerCase(),
    path_display: f.id,
    rev: `r${f.modified.replace(/\D/g, '')}`,
    size: Buffer.byteLength(f.content),
    server_modified: f.modified,
    content_hash: `h-${f.id}`,
    is_downloadable: true,
  };
}

function graphItem(f: FakeFile): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    size: Buffer.byteLength(f.content),
    eTag: `"${f.id}-${f.modified}"`,
    lastModifiedDateTime: f.modified,
    webUrl: `https://contoso.sharepoint.com/${f.name}`,
    file: { mimeType: f.mimeType, hashes: { quickXorHash: `xor-${f.id}-${f.modified}` } },
    parentReference: { path: '/drive/root:/Documents' },
  };
}

function escapeHtml(v: string): string {
  return v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
