import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server that plays Notion (OAuth with Basic + JSON, no
 * refresh token; users/me; search; pages; blocks/children) and
 * Atlassian (3LO OAuth with a JSON body and rotating refresh tokens;
 * /me; accessible-resources; the Confluence v2 API under
 * /ex/confluence/<cloud id>/wiki/api/v2) for the wiki-connector
 * suites, reached through SOURCE_OAUTH_NOTION_BASE_URL /
 * SOURCE_OAUTH_ATLASSIAN_BASE_URL under SOURCE_EGRESS_ALLOW_PRIVATE.
 *
 * Small and mutable: tests edit the pages between runs and read
 * `calls` to assert what the brain asked for.
 */
export interface FakeWiki {
  base: string;
  close(): Promise<void>;
  calls: Array<{
    method: string;
    path: string;
    auth: string | null;
    headers: Record<string, string>;
    body: string;
  }>;
  notion: {
    codes: Set<string>;
    tokens: Set<string>;
    workspace: string;
    /** Pages by id; `blocks[pageOrBlockId]` = its children. */
    pages: Map<string, NotionFakePage>;
    blocks: Map<string, NotionFakeBlock[]>;
  };
  atlassian: {
    codes: Set<string>;
    tokens: Set<string>;
    refreshSpent: Set<string>;
    cloudId: string;
    siteUrl: string;
    spaces: Array<{ id: string; key: string; name: string }>;
    pages: Map<string, ConfluenceFakePage>;
    blogposts: Map<string, ConfluenceFakePage>;
  };
}

export interface NotionFakePage {
  id: string;
  title: string;
  lastEdited: string;
  archived?: boolean;
  properties?: Record<string, unknown>;
  parent?: { type: string; page_id?: string; workspace?: boolean };
}

export interface NotionFakeBlock {
  id: string;
  type: string;
  body: Record<string, unknown>;
  hasChildren?: boolean;
}

export interface ConfluenceFakePage {
  id: string;
  title: string;
  spaceId: string;
  version: number;
  modified: string;
  storage: string;
  status?: string;
}

export async function startFakeWiki(): Promise<FakeWiki> {
  let serial = 0;
  const w: FakeWiki = {
    base: '',
    close: async () => undefined,
    calls: [],
    notion: {
      codes: new Set(),
      tokens: new Set(),
      workspace: 'Acme Wiki',
      pages: new Map(),
      blocks: new Map(),
    },
    atlassian: {
      codes: new Set(),
      tokens: new Set(),
      refreshSpent: new Set(),
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      spaces: [],
      pages: new Map(),
      blogposts: new Map(),
    },
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      w.calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        auth: req.headers.authorization ?? null,
        headers,
        body,
      });
      try {
        route(w, req, res, body, () => `tok_${++serial}`);
      } catch (e) {
        json(res, 500, { error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  w.base = `http://127.0.0.1:${port}`;
  w.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return w;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function consent(res: ServerResponse, title: string, back: URL): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><body><h2>${title}</h2><p><a id="allow" href="${back.toString().replace(/&/g, '&amp;')}">Allow</a></p></body></html>`,
  );
}

function route(
  w: FakeWiki,
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  mint: () => string,
): void {
  const url = new URL(req.url ?? '/', w.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  // ── Notion ──
  if (p === '/v1/oauth/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    const code = `nt_code_${w.notion.codes.size + 1}`;
    w.notion.codes.add(code);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    return consent(res, 'Fake Notion', back);
  }
  if (p === '/v1/oauth/token') {
    const basic = (req.headers.authorization ?? '').startsWith('Basic ')
      ? Buffer.from((req.headers.authorization ?? '').slice(6), 'base64').toString('utf8')
      : '';
    if (basic !== 'nt-client:nt-secret') return json(res, 401, { error: 'invalid_client' });
    let params: Record<string, string>;
    try {
      params = JSON.parse(body) as Record<string, string>;
    } catch {
      return json(res, 400, { error: 'invalid_request', error_description: 'JSON body expected' });
    }
    const known = new Set(['grant_type', 'code', 'redirect_uri', 'external_account']);
    const stray = Object.keys(params).filter((k) => !known.has(k));
    if (stray.length > 0)
      return json(res, 400, {
        error: 'invalid_request',
        error_description: `body.${stray[0]} should be not present`,
      });
    if (params.grant_type !== 'authorization_code' || !w.notion.codes.has(params.code ?? ''))
      return json(res, 400, { error: 'invalid_grant' });
    w.notion.codes.delete(params.code!);
    const access = mint();
    w.notion.tokens.add(access);
    return json(res, 200, {
      access_token: access,
      token_type: 'bearer',
      bot_id: 'bot-1',
      workspace_name: w.notion.workspace,
      workspace_id: 'ws-1',
      owner: { type: 'user', user: { object: 'user', id: 'u-1', name: 'Ada' } },
    });
  }
  if (p.startsWith('/v1/')) return notion(w, req, url, res, body, m);
  // ── Atlassian ──
  if (p === '/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    const code = `at_code_${w.atlassian.codes.size + 1}`;
    w.atlassian.codes.add(code);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    return consent(res, `Fake Atlassian (scope ${url.searchParams.get('scope') ?? ''})`, back);
  }
  if (p === '/oauth/token') {
    let params: Record<string, string>;
    try {
      params = JSON.parse(body) as Record<string, string>;
    } catch {
      return json(res, 400, { error: 'invalid_request' });
    }
    if (params.client_id !== 'at-client' || params.client_secret !== 'at-secret')
      return json(res, 401, { error: 'invalid_client' });
    const a = w.atlassian;
    if (params.grant_type === 'authorization_code') {
      if (!a.codes.has(params.code ?? '')) return json(res, 400, { error: 'invalid_grant' });
      a.codes.delete(params.code!);
    } else if (params.grant_type === 'refresh_token') {
      const rt = params.refresh_token ?? '';
      if (!rt.startsWith('at_rt_') || a.refreshSpent.has(rt))
        return json(res, 403, {
          error: 'invalid_grant',
          error_description: 'Unknown or invalid refresh token.',
        });
      a.refreshSpent.add(rt);
    } else return json(res, 400, { error: 'unsupported_grant_type' });
    const access = mint();
    a.tokens.add(access);
    return json(res, 200, {
      access_token: access,
      expires_in: 3600,
      token_type: 'Bearer',
      refresh_token: `at_rt_${access}`,
      scope: 'read:page:confluence offline_access',
    });
  }
  return atlassian(w, req, url, res, m);
}

function notion(
  w: FakeWiki,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  body: string,
  m: string,
): void {
  const n = w.notion;
  const token = bearerOf(req);
  if (!token || !n.tokens.has(token))
    return json(res, 401, {
      object: 'error',
      code: 'unauthorized',
      message: 'API token is invalid.',
    });
  if (!req.headers['notion-version'])
    return json(res, 400, {
      object: 'error',
      code: 'missing_version',
      message: 'Notion-Version header failed validation',
    });
  const p = url.pathname;
  if (p === '/v1/users/me')
    return json(res, 200, {
      object: 'user',
      id: 'bot-1',
      type: 'bot',
      name: 'Brain',
      bot: { workspace_name: n.workspace },
    });
  if (p === '/v1/search' && m === 'POST') {
    const q = JSON.parse(body || '{}') as { start_cursor?: string; page_size?: number };
    const all = [...n.pages.values()]
      .filter((x) => !x.archived)
      .sort((a, b) => (a.lastEdited < b.lastEdited ? 1 : -1));
    const size = q.page_size ?? 100;
    const start = q.start_cursor ? Number(q.start_cursor) : 0;
    const slice = all.slice(start, start + size);
    return json(res, 200, {
      object: 'list',
      results: slice.map(pageJson),
      has_more: start + size < all.length,
      next_cursor: start + size < all.length ? String(start + size) : null,
    });
  }
  const pm = /^\/v1\/pages\/([^/]+)$/.exec(p);
  if (pm && m === 'GET') {
    const page = n.pages.get(pm[1]!);
    if (!page || page.archived)
      return json(res, 404, {
        object: 'error',
        code: 'object_not_found',
        message: 'Could not find page',
      });
    return json(res, 200, pageJson(page));
  }
  const bm = /^\/v1\/blocks\/([^/]+)\/children$/.exec(p);
  if (bm && m === 'GET') {
    const list = n.blocks.get(bm[1]!) ?? [];
    const size = Number(url.searchParams.get('page_size') ?? 100);
    const start = Number(url.searchParams.get('start_cursor') ?? 0);
    const slice = list.slice(start, start + size);
    return json(res, 200, {
      object: 'list',
      results: slice.map((b) => ({
        object: 'block',
        id: b.id,
        type: b.type,
        has_children: b.hasChildren ?? n.blocks.has(b.id),
        [b.type]: b.body,
      })),
      has_more: start + size < list.length,
      next_cursor: start + size < list.length ? String(start + size) : null,
    });
  }
  return json(res, 404, { object: 'error', code: 'not_found', message: `${m} ${p}` });
}

function pageJson(page: NotionFakePage): Record<string, unknown> {
  return {
    object: 'page',
    id: page.id,
    url: `https://www.notion.so/${page.id.replace(/-/g, '')}`,
    last_edited_time: page.lastEdited,
    created_time: page.lastEdited,
    archived: page.archived ?? false,
    in_trash: false,
    parent: page.parent ?? { type: 'workspace', workspace: true },
    properties: {
      title: {
        id: 'title',
        type: 'title',
        title: [{ type: 'text', plain_text: page.title, href: null }],
      },
      ...(page.properties ?? {}),
    },
  };
}

function atlassian(
  w: FakeWiki,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  m: string,
): void {
  const a = w.atlassian;
  const token = bearerOf(req);
  if (!token || !a.tokens.has(token)) return json(res, 401, { code: 401, message: 'Unauthorized' });
  const p = url.pathname;
  if (p === '/me')
    return json(res, 200, { account_id: 'acc-1', email: 'ada@acme.test', name: 'Ada Lovelace' });
  if (p === '/oauth/token/accessible-resources')
    return json(res, 200, [
      {
        id: a.cloudId,
        name: 'Acme',
        url: a.siteUrl,
        scopes: ['read:page:confluence', 'read:space:confluence'],
      },
    ]);
  const apiRoot = `/ex/confluence/${a.cloudId}/wiki/api/v2`;
  if (!p.startsWith(apiRoot)) return json(res, 404, { message: `${m} ${p}` });
  const rel = p.slice(apiRoot.length);
  if (rel === '/spaces') {
    const keys = (url.searchParams.get('keys') ?? '').split(',').filter(Boolean);
    return json(res, 200, {
      results: a.spaces.filter((s) => keys.length === 0 || keys.includes(s.key)),
      _links: {},
    });
  }
  const lm = /^\/(pages|blogposts)$/.exec(rel);
  if (lm) {
    const store = lm[1] === 'pages' ? a.pages : a.blogposts;
    const spaceIds = (url.searchParams.get('space-id') ?? '').split(',').filter(Boolean);
    const all = [...store.values()]
      .filter(
        (x) =>
          (x.status ?? 'current') === 'current' &&
          (spaceIds.length === 0 || spaceIds.includes(x.spaceId)),
      )
      .sort((x, y) => (x.modified < y.modified ? 1 : -1));
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const slice = all.slice(cursor, cursor + limit);
    const more = cursor + limit < all.length;
    return json(res, 200, {
      results: slice.map((x) => summary(x, url.searchParams.get('body-format') === 'storage')),
      _links: {
        base: `${a.siteUrl}/wiki`,
        ...(more ? { next: `/wiki/api/v2/${lm[1]}?cursor=${cursor + limit}&limit=${limit}` } : {}),
      },
    });
  }
  const gm = /^\/(pages|blogposts)\/([^/]+)$/.exec(rel);
  if (gm) {
    const store = gm[1] === 'pages' ? a.pages : a.blogposts;
    const x = store.get(gm[2]!);
    if (!x || (x.status ?? 'current') !== 'current')
      return json(res, 404, { message: 'No content found with id' });
    return json(res, 200, summary(x, url.searchParams.get('body-format') === 'storage'));
  }
  return json(res, 404, { message: `${m} ${p}` });
}

function summary(x: ConfluenceFakePage, withBody: boolean): Record<string, unknown> {
  return {
    id: x.id,
    status: x.status ?? 'current',
    title: x.title,
    spaceId: x.spaceId,
    version: { number: x.version, createdAt: x.modified },
    ...(withBody ? { body: { storage: { representation: 'storage', value: x.storage } } } : {}),
    _links: { webui: `/spaces/${x.spaceId}/pages/${x.id}` },
  };
}
