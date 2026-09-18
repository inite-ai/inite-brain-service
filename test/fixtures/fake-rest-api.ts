import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A made-up CRM with a JSON list API and an OpenAPI document — the
 * long tail the `rest_records` connector and the mapping assistant are
 * for. Deliberately inconsistent, like the real thing: deals page by
 * cursor under `data` with `updated_since` (ISO), contacts page by
 * number under `items` with `modified_since` (epoch seconds), companies
 * follow a `next` link, tickets are a POST search with an offset in the
 * body, users are a lookup no one should sync. The credential rides as
 * the test says: an `X-Api-Key` header, an `api_key` query parameter, or
 * a bearer.
 */
export interface FakeRestApi {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
  key: string;
  auth: 'header' | 'query' | 'bearer';
  deals: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  companies: Array<Record<string, unknown>>;
  tickets: Array<Record<string, unknown>>;
  openapi(): Record<string, unknown>;
}

const PAGE = 2;

export async function startFakeRestApi(): Promise<FakeRestApi> {
  const api: FakeRestApi = {
    base: '',
    close: async () => undefined,
    calls: [],
    key: 'k-rest-1',
    auth: 'header',
    deals: [],
    contacts: [],
    companies: [],
    tickets: [],
    openapi: () => openapiDoc(api.base),
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      api.calls.push({ method: req.method ?? '', path: req.url ?? '', headers, body });
      try {
        route(api, req, res, body);
      } catch (e) {
        json(res, 500, { error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  api.base = `http://127.0.0.1:${port}`;
  api.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return api;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(api: FakeRestApi, req: IncomingMessage, url: URL): boolean {
  switch (api.auth) {
    case 'header':
      return req.headers['x-api-key'] === api.key;
    case 'query':
      return url.searchParams.get('api_key') === api.key;
    default:
      return req.headers.authorization === `Bearer ${api.key}`;
  }
}

function route(api: FakeRestApi, req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', api.base);
  const p = url.pathname;
  const m = req.method ?? 'GET';
  if (p === '/openapi.json') return json(res, 200, api.openapi());
  if (p === '/openapi.yaml') {
    res.writeHead(200, { 'content-type': 'application/yaml' });
    res.end(toYaml(api.openapi()));
    return;
  }
  if (!authorized(api, req, url)) return json(res, 401, { error: 'unauthorized' });
  const sortByUpdated = (rows: Array<Record<string, unknown>>) =>
    [...rows].sort((a, b) => Date.parse(String(a.updated_at)) - Date.parse(String(b.updated_at)));

  if (p === '/api/deals' && m === 'GET') {
    const since = url.searchParams.get('updated_since');
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? PAGE);
    const all = sortByUpdated(api.deals).filter(
      (r) => !since || Date.parse(String(r.updated_at)) >= Date.parse(since),
    );
    const slice = all.slice(cursor, cursor + limit);
    return json(res, 200, {
      data: slice,
      next_cursor: cursor + limit < all.length ? String(cursor + limit) : null,
    });
  }
  const dm = /^\/api\/deals\/(\d+)$/.exec(p);
  if (dm && m === 'GET') {
    const one = api.deals.find((d) => String(d.id) === dm[1]);
    return one ? json(res, 200, { data: one }) : json(res, 404, { error: 'not found' });
  }
  if (p === '/api/contacts' && m === 'GET') {
    const since = Number(url.searchParams.get('modified_since') ?? 0);
    const page = Number(url.searchParams.get('page') ?? 1);
    const per = Number(url.searchParams.get('per_page') ?? PAGE);
    const all = sortByUpdated(api.contacts).filter(
      (r) => !since || Date.parse(String(r.updated_at)) / 1000 >= since,
    );
    return json(res, 200, { items: all.slice((page - 1) * per, page * per), total: all.length });
  }
  if (p === '/api/companies' && m === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const all = sortByUpdated(api.companies);
    const slice = all.slice(after, after + PAGE);
    const more = after + PAGE < all.length;
    return json(res, 200, {
      items: slice,
      next: more ? `${api.base}/api/companies?after=${after + PAGE}` : null,
    });
  }
  if (p === '/api/tickets/search' && m === 'POST') {
    const q = body ? (JSON.parse(body) as { offset?: number; limit?: number; since?: string }) : {};
    const offset = q.offset ?? 0;
    const limit = q.limit ?? PAGE;
    const all = sortByUpdated(api.tickets).filter(
      (r) => !q.since || Date.parse(String(r.updated_at)) >= Date.parse(q.since),
    );
    return json(res, 200, { results: all.slice(offset, offset + limit), total: all.length });
  }
  if (p === '/api/users' && m === 'GET')
    return json(res, 200, { data: [{ id: 1, name: 'Grace' }] });
  return json(res, 404, { error: `no route ${m} ${p}` });
}

function openapiDoc(base: string): Record<string, unknown> {
  const row = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  const q = (name: string, type = 'string') => ({ name, in: 'query', schema: { type } });
  const ok = (schema: unknown) => ({
    '200': { description: 'ok', content: { 'application/json': { schema } } },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'Acme CRM', version: '1.0' },
    servers: [{ url: `${base}/api` }],
    paths: {
      '/deals': {
        get: {
          operationId: 'listDeals',
          summary: 'List deals',
          parameters: [q('updated_since'), q('cursor'), q('limit', 'integer')],
          responses: ok({
            type: 'object',
            properties: {
              data: { type: 'array', items: { $ref: '#/components/schemas/Deal' } },
              next_cursor: { type: 'string', nullable: true },
            },
          }),
        },
      },
      '/deals/{id}': {
        get: {
          operationId: 'getDeal',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: ok({
            type: 'object',
            properties: { data: { $ref: '#/components/schemas/Deal' } },
          }),
        },
      },
      '/contacts': {
        get: {
          operationId: 'listContacts',
          parameters: [
            q('modified_since', 'integer'),
            q('page', 'integer'),
            q('per_page', 'integer'),
          ],
          responses: ok({
            type: 'object',
            properties: {
              items: { type: 'array', items: { $ref: '#/components/schemas/Contact' } },
              total: { type: 'integer' },
            },
          }),
        },
      },
      '/companies': {
        get: {
          operationId: 'listCompanies',
          parameters: [q('after', 'integer')],
          responses: ok({
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: row({
                  id: { type: 'integer' },
                  name: { type: 'string' },
                  domain: { type: 'string' },
                  industry: { type: 'string' },
                  updated_at: { type: 'string' },
                }),
              },
              next: { type: 'string', nullable: true },
            },
          }),
        },
      },
      '/tickets/search': {
        post: {
          operationId: 'searchTickets',
          requestBody: {
            content: {
              'application/json': {
                schema: row({
                  offset: { type: 'integer' },
                  limit: { type: 'integer' },
                  since: { type: 'string' },
                }),
              },
            },
          },
          responses: ok({
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: row({
                  id: { type: 'integer' },
                  subject: { type: 'string' },
                  status: { type: 'string' },
                  priority: { type: 'string' },
                  contact_id: { type: 'integer' },
                  updated_at: { type: 'string' },
                }),
              },
              total: { type: 'integer' },
            },
          }),
        },
      },
      '/users': {
        get: {
          operationId: 'listUsers',
          responses: ok({
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: row({ id: { type: 'integer' }, name: { type: 'string' } }),
              },
            },
          }),
        },
      },
      '/deals/{id}/notes': {
        post: { operationId: 'addNote', responses: { '201': { description: 'created' } } },
      },
    },
    components: {
      schemas: {
        Deal: {
          allOf: [
            { $ref: '#/components/schemas/Base' },
            row({
              title: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string' },
              stage: { type: 'string' },
              status: { type: 'string' },
              owner_name: { type: 'string' },
              contact_id: { type: 'integer' },
              company_id: { type: 'integer' },
              expected_close: { type: 'string' },
              is_deleted: { type: 'boolean' },
            }),
          ],
        },
        Contact: {
          allOf: [
            { $ref: '#/components/schemas/Base' },
            row({
              first_name: { type: 'string' },
              last_name: { type: 'string' },
              email: { type: 'string' },
              position: { type: 'string' },
              company_id: { type: 'integer' },
            }),
          ],
        },
        Base: row({ id: { type: 'integer' }, updated_at: { type: 'string' } }),
      },
    },
  };
}

/** Enough YAML for an OpenAPI document (the parser is the real one on the other side). */
function toYaml(v: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v
      .map((x) =>
        typeof x === 'object' && x !== null
          ? `${pad}-\n${toYaml(x, indent + 2)}`
          : `${pad}- ${scalar(x)}`,
      )
      .join('\n');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return `${pad}{}`;
    return entries
      .map(([k, x]) => {
        const key = /^[A-Za-z0-9_]+$/.test(k) ? k : JSON.stringify(k);
        if (x && typeof x === 'object') {
          const inner = toYaml(x, indent + 2);
          return Array.isArray(x) && !x.length
            ? `${pad}${key}: []`
            : !Array.isArray(x) && !Object.keys(x).length
              ? `${pad}${key}: {}`
              : `${pad}${key}:\n${inner}`;
        }
        return `${pad}${key}: ${scalar(x)}`;
      })
      .join('\n');
  }
  return `${pad}${scalar(v)}`;
}

function scalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}
