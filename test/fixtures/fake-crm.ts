import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server that plays HubSpot (OAuth + CRM v3/v4), Bitrix24
 * (inbound-webhook REST) and Kommo (API v4) for the CRM-connector
 * suites. HubSpot is reached through SOURCE_OAUTH_HUBSPOT_BASE_URL
 * (paths kept) under SOURCE_EGRESS_ALLOW_PRIVATE; Bitrix24 through a
 * webhook URL under this origin; Kommo through `config.baseUrl` — the
 * last two with `config.allowPrivate: true`.
 *
 * Deliberately small and mutable: tests edit the rows between runs and
 * read `calls` to assert what the brain asked for.
 */
export interface FakeCrm {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  hubspot: {
    /** Bearer tokens accepted (minted by the token endpoint, or private-app tokens a test adds). */
    tokens: Set<string>;
    codes: Set<string>;
    identity: { user: string; hubDomain: string };
    owners: Array<{ id: string; firstName: string; lastName: string }>;
    pipelines: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>;
    lifecycle: Array<{ id: string; label: string }>;
    /** Rows per object; `properties` as HubSpot returns them (strings). */
    objects: Record<
      'deals' | 'contacts' | 'companies',
      Array<{ id: string; properties: Record<string, string | null> }>
    >;
    /** `${from}/${to}` → from id → to ids. */
    associations: Record<string, Record<string, string[]>>;
    /** Report the cap on the first unfiltered deals page (narrowing test). */
    pretendCap: boolean;
  };
  bitrix24: {
    /** Webhook codes accepted under /rest/<user>/<code>/. */
    codes: Set<string>;
    /** Items per entityTypeId (camelCase, as crm.item.* returns them). */
    items: Record<number, Array<Record<string, unknown>>>;
    statuses: Array<{ ENTITY_ID: string; STATUS_ID: string; NAME: string }>;
    categories: Array<{ id: number; name: string }>;
    users: Array<{ ID: string; NAME: string; LAST_NAME: string }> | null;
    /** Answer the next method call with this HTTP status (then cleared). */
    failNext: number | null;
  };
  kommo: {
    tokens: Set<string>;
    pipelines: Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>;
    lossReasons: Array<{ id: number; name: string }>;
    users: Array<{ id: number; name: string }>;
    currency: string;
    rows: Record<'leads' | 'contacts' | 'companies', Array<Record<string, unknown>>>;
  };
}

export async function startFakeCrm(): Promise<FakeCrm> {
  let serial = 0;
  const crm: FakeCrm = {
    base: '',
    close: async () => undefined,
    calls: [],
    hubspot: {
      tokens: new Set(),
      codes: new Set(),
      identity: { user: 'owner@example.test', hubDomain: 'acme.hubspot.com' },
      owners: [],
      pipelines: [],
      lifecycle: [],
      objects: { deals: [], contacts: [], companies: [] },
      associations: {},
      pretendCap: false,
    },
    bitrix24: {
      codes: new Set(),
      items: {},
      statuses: [],
      categories: [],
      users: [],
      failNext: null,
    },
    kommo: {
      tokens: new Set(),
      pipelines: [],
      lossReasons: [],
      users: [],
      currency: 'USD',
      rows: { leads: [], contacts: [], companies: [] },
    },
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const auth = req.headers.authorization ?? null;
      crm.calls.push({ method: req.method ?? '', path: req.url ?? '', auth, body });
      try {
        route(crm, req, res, body, () => `tok_${++serial}`);
      } catch (e) {
        json(res, 500, { error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  crm.base = `http://127.0.0.1:${port}`;
  crm.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return crm;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function bearerOf(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function route(
  crm: FakeCrm,
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  mint: () => string,
): void {
  const url = new URL(req.url ?? '/', crm.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (p.startsWith('/rest/')) return bitrix24(crm, url, res, body);
  if (p.startsWith('/api/v4/')) return kommo(crm, req, url, res);
  return hubspot(crm, req, url, res, body, m, mint);
}

// ── HubSpot ──

function hubspot(
  crm: FakeCrm,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  body: string,
  m: string,
  mint: () => string,
): void {
  const p = url.pathname;
  const h = crm.hubspot;
  if (m === 'GET' && p === '/oauth/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    const code = `hs_code_${h.codes.size + 1}`;
    h.codes.add(code);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body><h2>Fake HubSpot</h2><p>scopes: <code>${escapeHtml(url.searchParams.get('scope') ?? '')}</code></p>` +
        `<p><a id="allow" href="${escapeHtml(back.toString())}">Allow</a></p></body></html>`,
    );
    return;
  }
  if (m === 'POST' && p === '/oauth/v1/token') {
    const params = new URLSearchParams(body);
    const grant = params.get('grant_type');
    if (!params.get('client_id') || !params.get('client_secret'))
      return json(res, 400, { error: 'invalid_client' });
    if (grant === 'authorization_code') {
      const code = params.get('code') ?? '';
      if (!h.codes.has(code)) return json(res, 400, { error: 'invalid_grant' });
      h.codes.delete(code);
    } else if (grant !== 'refresh_token' || !params.get('refresh_token')?.startsWith('hs_rt_')) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    const access = mint();
    h.tokens.add(access);
    return json(res, 200, {
      access_token: access,
      refresh_token: `hs_rt_${access}`,
      expires_in: 1800,
      token_type: 'bearer',
    });
  }
  const token = bearerOf(req);
  const idm = /^\/oauth\/v1\/access-tokens\/([^/]+)$/.exec(p);
  if (idm) {
    if (!h.tokens.has(decodeURIComponent(idm[1]!)))
      return json(res, 404, { message: 'no such token' });
    return json(res, 200, { user: h.identity.user, hub_domain: h.identity.hubDomain, hub_id: 1 });
  }
  if (!token || !h.tokens.has(token))
    return json(res, 401, { status: 'error', message: 'Authentication credentials not found' });
  if (p === '/crm/v3/owners') return json(res, 200, { results: h.owners });
  const pm = /^\/crm\/v3\/pipelines\/(deals|contacts)$/.exec(p);
  if (pm) {
    if (pm[1] === 'deals') return json(res, 200, { results: h.pipelines });
    return json(res, 200, { results: [{ id: 'contacts-lifecycle', stages: h.lifecycle }] });
  }
  const am =
    /^\/crm\/v4\/associations\/(deals|contacts|companies)\/(deals|contacts|companies)\/batch\/read$/.exec(
      p,
    );
  if (am && m === 'POST') {
    const table = h.associations[`${am[1]}/${am[2]}`] ?? {};
    const inputs = (JSON.parse(body) as { inputs: Array<{ id: string }> }).inputs;
    const results = inputs
      .filter((i) => (table[i.id] ?? []).length > 0)
      .map((i) => ({
        from: { id: i.id },
        to: (table[i.id] ?? []).map((toObjectId) => ({
          toObjectId,
          associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 1, label: null }],
        })),
      }));
    return json(res, 200, { status: 'COMPLETE', results });
  }
  const sm = /^\/crm\/v3\/objects\/(deals|contacts|companies)\/search$/.exec(p);
  if (sm && m === 'POST') {
    const q = JSON.parse(body) as {
      filterGroups?: Array<{
        filters: Array<{ propertyName: string; operator: string; value: string }>;
      }>;
      sorts?: Array<{ propertyName: string; direction: string }>;
      properties?: string[];
      limit?: number;
      after?: string;
    };
    const sortBy = q.sorts?.[0]?.propertyName ?? 'hs_lastmodifieddate';
    const gte = q.filterGroups?.[0]?.filters.find((f) => f.operator === 'GTE');
    const after = Number(q.after ?? 0);
    if (after >= 10_000) return json(res, 400, { message: 'after cannot exceed 10000' });
    const rows = h.objects[sm[1] as 'deals']
      .filter((r) => !gte || Date.parse(r.properties[gte.propertyName] ?? '') >= Number(gte.value))
      .sort(
        (a, b) => Date.parse(a.properties[sortBy] ?? '') - Date.parse(b.properties[sortBy] ?? ''),
      );
    const limit = q.limit ?? 100;
    const slice = rows.slice(after, after + limit).map((r) => ({
      id: r.id,
      properties: Object.fromEntries((q.properties ?? []).map((k) => [k, r.properties[k] ?? null])),
    }));
    const more = after + limit < rows.length;
    const pretend = h.pretendCap && !gte && sm[1] === 'deals';
    return json(res, 200, {
      total: rows.length,
      results: slice,
      ...(more || pretend
        ? { paging: { next: { after: pretend ? '10000' : String(after + limit) } } }
        : {}),
    });
  }
  const om = /^\/crm\/v3\/objects\/(deals|contacts|companies)\/([^/]+)$/.exec(p);
  if (om && m === 'GET') {
    const row = h.objects[om[1] as 'deals'].find((r) => r.id === om[2]);
    if (!row) return json(res, 404, { message: 'not found' });
    const wanted = (url.searchParams.get('properties') ?? '').split(',').filter(Boolean);
    const assoc: Record<string, { results: Array<{ id: string; type: string }> }> = {};
    for (const to of (url.searchParams.get('associations') ?? '').split(',').filter(Boolean)) {
      const ids = h.associations[`${om[1]}/${to}`]?.[row.id] ?? [];
      if (ids.length) assoc[to] = { results: ids.map((id) => ({ id, type: `${om[1]}_to_${to}` })) };
    }
    return json(res, 200, {
      id: row.id,
      properties: Object.fromEntries(wanted.map((k) => [k, row.properties[k] ?? null])),
      ...(Object.keys(assoc).length ? { associations: assoc } : {}),
    });
  }
  return json(res, 404, { message: `no route ${m} ${p}` });
}

// ── Bitrix24 ──

function bitrix24(crm: FakeCrm, url: URL, res: ServerResponse, body: string): void {
  const b = crm.bitrix24;
  const mm = /^\/rest\/(\d+)\/([^/]+)\/([a-z.]+)\.json$/.exec(url.pathname);
  if (!mm) return json(res, 404, { error: 'NOT_FOUND', error_description: 'bad path' });
  if (!b.codes.has(mm[2]!))
    return json(res, 401, {
      error: 'INVALID_CREDENTIALS',
      error_description: 'Invalid request credentials',
    });
  const params = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const method = mm[3]!;
  if (b.failNext) {
    const status = b.failNext;
    b.failNext = null;
    return json(res, status, { error: 'FAKE_FAILURE', error_description: `as told (${status})` });
  }
  if (method === 'crm.status.list') return json(res, 200, { result: b.statuses });
  if (method === 'crm.category.list')
    return json(res, 200, { result: { categories: b.categories } });
  if (method === 'user.get') {
    if (!b.users)
      return json(res, 403, {
        error: 'insufficient_scope',
        error_description: 'The request requires higher privileges',
      });
    return json(res, 200, { result: b.users });
  }
  if (method === 'crm.item.list') {
    const typeId = Number(params.entityTypeId);
    const filter = (params.filter ?? {}) as Record<string, string>;
    const since = filter['>updatedTime'];
    const start = Number(params.start ?? 0);
    const rows = (b.items[typeId] ?? [])
      .filter((r) => !since || Date.parse(String(r.updatedTime)) > Date.parse(since))
      .sort((x, y) => Date.parse(String(x.updatedTime)) - Date.parse(String(y.updatedTime)));
    const slice = rows.slice(start, start + 50);
    return json(res, 200, {
      result: { items: slice },
      total: rows.length,
      ...(start + 50 < rows.length ? { next: start + 50 } : {}),
    });
  }
  if (method === 'crm.item.get') {
    const typeId = Number(params.entityTypeId);
    const item = (b.items[typeId] ?? []).find((r) => Number(r.id) === Number(params.id));
    if (!item) return json(res, 400, { error: 'NOT_FOUND', error_description: 'Item not found' });
    return json(res, 200, { result: { item } });
  }
  return json(res, 400, { error: 'ERROR_METHOD_NOT_FOUND', error_description: method });
}

// ── Kommo ──

function kommo(crm: FakeCrm, req: IncomingMessage, url: URL, res: ServerResponse): void {
  const k = crm.kommo;
  const token = bearerOf(req);
  if (!token || !k.tokens.has(token)) return json(res, 401, { title: 'Unauthorized', status: 401 });
  const p = url.pathname;
  if (p === '/api/v4/account') return json(res, 200, { id: 1, currency: k.currency });
  if (p === '/api/v4/leads/pipelines')
    return json(res, 200, {
      _embedded: {
        pipelines: k.pipelines.map((pl) => ({
          id: pl.id,
          name: pl.name,
          _embedded: { statuses: pl.statuses.map((s) => ({ ...s, pipeline_id: pl.id })) },
        })),
      },
    });
  if (p === '/api/v4/leads/loss_reasons')
    return json(res, 200, { _embedded: { loss_reasons: k.lossReasons } });
  if (p === '/api/v4/users') return json(res, 200, { _embedded: { users: k.users } });
  const lm = /^\/api\/v4\/(leads|contacts|companies)(?:\/(\d+))?$/.exec(p);
  if (!lm) return json(res, 404, { title: 'Not Found', status: 404 });
  const rows = k.rows[lm[1] as 'leads'];
  if (lm[2]) {
    const one = rows.find((r) => String(r.id) === lm[2]);
    return one ? json(res, 200, one) : json(res, 404, { title: 'Not Found', status: 404 });
  }
  const from = Number(url.searchParams.get('filter[updated_at][from]') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 250);
  const pageNo = Number(url.searchParams.get('page') ?? 1);
  const all = rows
    .filter((r) => Number(r.updated_at) >= from)
    .sort((x, y) => Number(x.updated_at) - Number(y.updated_at));
  const slice = all.slice((pageNo - 1) * limit, pageNo * limit);
  if (!slice.length) {
    res.writeHead(204);
    res.end();
    return;
  }
  const more = pageNo * limit < all.length;
  return json(res, 200, {
    _page: pageNo,
    _links: {
      self: { href: url.toString() },
      ...(more ? { next: { href: `${url}&page=${pageNo + 1}` } } : {}),
    },
    _embedded: { [lm[1]!]: slice },
  });
}

function escapeHtml(v: string): string {
  return v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
