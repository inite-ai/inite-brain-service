import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createVerify } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * One loopback server that plays a Salesforce org AND its login host for
 * the `salesforce` connector suites: OAuth (authorize → code, the token
 * endpoint with `instance_url` + `id`, userinfo / the identity URL, the
 * JWT bearer grant verified against the test's public key), SOQL over
 * REST (`/services/data/vXX.X/query` with `nextRecordsUrl` paging, a
 * minimal SOQL reader: object, `LastModifiedDate >`), one record by id,
 * the deleted-ids feed, and Bulk API 2.0 query jobs (poll count, CSV
 * pages by `Sforce-Locator`). Reached through
 * SOURCE_OAUTH_SALESFORCE_BASE_URL under SOURCE_EGRESS_ALLOW_PRIVATE.
 */
export interface FakeSalesforce {
  base: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  tokens: Set<string>;
  codes: Set<string>;
  /** The connected app's consumer key and the JWT user, with the PEM public key the assertion must verify under. */
  jwt: { clientId: string; username: string; publicKey: string | null };
  identity: { username: string; userId: string; orgId: string };
  /** Rows per object, as the query endpoint returns them (nested relationship fields). */
  objects: Record<string, Array<Record<string, unknown>>>;
  /** Deleted ids per object with their deletedDate. */
  deleted: Record<string, Array<{ id: string; deletedDate: string }>>;
  pageSize: number;
  /** Bulk: how many status polls before JobComplete, and the CSV page size. */
  bulkPolls: number;
  bulkPageSize: number;
}

export async function startFakeSalesforce(): Promise<FakeSalesforce> {
  let serial = 0;
  const sf: FakeSalesforce = {
    base: '',
    close: async () => undefined,
    calls: [],
    tokens: new Set(),
    codes: new Set(),
    jwt: { clientId: 'sf-consumer-key', username: 'integration@acme.test', publicKey: null },
    identity: { username: 'owner@acme.test', userId: '005xx000001', orgId: '00Dxx0000001' },
    objects: {},
    deleted: {},
    pageSize: 2,
    bulkPolls: 1,
    bulkPageSize: 2,
  };
  const locators = new Map<string, { object: string; since: string | null; offset: number }>();
  const jobs = new Map<string, { object: string; polls: number }>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      sf.calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        auth: req.headers.authorization ?? null,
        body,
      });
      try {
        route({ sf, req, res, body, serialize: () => ++serial, locators, jobs });
      } catch (e) {
        json(res, 500, [{ message: (e as Error).message, errorCode: 'UNKNOWN' }]);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  sf.base = `http://127.0.0.1:${port}`;
  sf.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return sf;
}

function json(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function route(p: {
  sf: FakeSalesforce;
  req: IncomingMessage;
  res: ServerResponse;
  body: string;
  serialize: () => number;
  locators: Map<string, { object: string; since: string | null; offset: number }>;
  jobs: Map<string, { object: string; polls: number }>;
}): void {
  const { sf, req, res, body } = p;
  const url = new URL(req.url ?? '/', sf.base);
  const path = url.pathname;
  const m = req.method ?? 'GET';

  // ── login host ──
  if (m === 'GET' && path === '/services/oauth2/authorize') {
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (!url.searchParams.get('code_challenge')) return json(res, 400, { error: 'no PKCE' });
    const code = `sfcode_${p.serialize()}`;
    sf.codes.add(code);
    const back = new URL(redirect);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body><h2>Fake Salesforce</h2><p>scope: <code>${escapeHtml(url.searchParams.get('scope') ?? '')}</code></p><p><a id="allow" href="${escapeHtml(back.toString())}">Allow</a></p></body></html>`,
    );
    return;
  }
  if (m === 'POST' && path === '/services/oauth2/token') {
    const params = new URLSearchParams(body);
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      const code = params.get('code') ?? '';
      if (!sf.codes.has(code)) return json(res, 400, { error: 'invalid_grant' });
      if (!params.get('code_verifier')) return json(res, 400, { error: 'invalid_request' });
      sf.codes.delete(code);
    } else if (grant === 'refresh_token') {
      if (!params.get('refresh_token')?.startsWith('sfrt_'))
        return json(res, 400, { error: 'invalid_grant' });
    } else if (grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      const verdict = verifyAssertion(sf, params.get('assertion') ?? '');
      if (verdict) return json(res, 400, { error: 'invalid_grant', error_description: verdict });
    } else {
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const access = `sftok_${p.serialize()}`;
    sf.tokens.add(access);
    return json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      instance_url: sf.base,
      id: `${sf.base}/id/${sf.identity.orgId}/${sf.identity.userId}`,
      issued_at: String(Date.now()),
      scope: params.get('scope') ?? 'api refresh_token openid',
      ...(grant === 'authorization_code' ? { refresh_token: `sfrt_${access}` } : {}),
    });
  }
  if (m === 'POST' && path === '/services/oauth2/revoke') return json(res, 200, {});

  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
  if (!bearer || !sf.tokens.has(bearer)) {
    return json(res, 401, [
      { message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' },
    ]);
  }
  if (path === '/services/oauth2/userinfo') {
    return json(res, 200, {
      preferred_username: sf.identity.username,
      user_id: sf.identity.userId,
    });
  }
  const idm = /^\/id\/([^/]+)\/([^/]+)$/.exec(path);
  if (idm) {
    return json(res, 200, {
      username: sf.identity.username,
      display_name: 'Owner',
      user_id: sf.identity.userId,
      organization_id: sf.identity.orgId,
    });
  }

  // ── the org ──
  const v = /^\/services\/data\/(v\d+\.\d)\/(.*)$/.exec(path);
  if (!v) return json(res, 404, [{ message: `no route ${m} ${path}`, errorCode: 'NOT_FOUND' }]);
  const rest = v[2]!;
  if (rest === 'query' && m === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    const object = /FROM (\w+)/.exec(q)?.[1] ?? '';
    const since = /LastModifiedDate > (\S+)/.exec(q)?.[1] ?? null;
    return page(p, res, { object, since, offset: 0 }, v[1]!);
  }
  const qm = /^query\/([^/]+)$/.exec(rest);
  if (qm && m === 'GET') {
    const loc = p.locators.get(qm[1]!);
    if (!loc)
      return json(res, 400, [{ message: 'invalid locator', errorCode: 'INVALID_QUERY_LOCATOR' }]);
    return page(p, res, loc, v[1]!);
  }
  const dm = /^sobjects\/(\w+)\/deleted\/?$/.exec(rest);
  if (dm && m === 'GET') {
    const start = url.searchParams.get('start') ?? '';
    const rows = (sf.deleted[dm[1]!] ?? []).filter((d) => d.deletedDate >= start);
    return json(res, 200, {
      deletedRecords: rows,
      earliestDateAvailable: start,
      latestDateCovered: url.searchParams.get('end'),
    });
  }
  const om = /^sobjects\/(\w+)\/([A-Za-z0-9]+)$/.exec(rest);
  if (om && m === 'GET') {
    const one = (sf.objects[om[1]!] ?? []).find((r) => r.Id === om[2]);
    return one
      ? json(res, 200, one)
      : json(res, 404, [{ message: 'not found', errorCode: 'NOT_FOUND' }]);
  }
  if (rest === 'jobs/query' && m === 'POST') {
    const parsed = JSON.parse(body) as { query?: string };
    const object = /FROM (\w+)/.exec(parsed.query ?? '')?.[1] ?? '';
    const id = `750xx${p.serialize()}`;
    p.jobs.set(id, { object, polls: 0 });
    return json(res, 200, { id, state: 'UploadComplete', operation: 'query', object });
  }
  const jm = /^jobs\/query\/([^/]+)$/.exec(rest);
  if (jm && m === 'GET') {
    const job = p.jobs.get(jm[1]!);
    if (!job) return json(res, 404, [{ message: 'no job', errorCode: 'NOT_FOUND' }]);
    job.polls++;
    return json(res, 200, {
      id: jm[1],
      state: job.polls >= sf.bulkPolls ? 'JobComplete' : 'InProgress',
    });
  }
  const rm = /^jobs\/query\/([^/]+)\/results$/.exec(rest);
  if (rm && m === 'GET') {
    const job = p.jobs.get(rm[1]!);
    if (!job) return json(res, 404, [{ message: 'no job', errorCode: 'NOT_FOUND' }]);
    const offset = Number(url.searchParams.get('locator') ?? 0);
    const size = sf.bulkPageSize;
    const all = sorted(sf.objects[job.object] ?? []);
    const slice = all.slice(offset, offset + size);
    const more = offset + size < all.length;
    res.writeHead(200, {
      'content-type': 'text/csv',
      'sforce-locator': more ? String(offset + size) : 'null',
      'sforce-numberofrecords': String(slice.length),
    });
    res.end(toCsv(slice));
    return;
  }
  return json(res, 404, [{ message: `no route ${m} ${path}`, errorCode: 'NOT_FOUND' }]);
}

function page(
  p: {
    sf: FakeSalesforce;
    serialize: () => number;
    locators: Map<string, { object: string; since: string | null; offset: number }>;
  },
  res: ServerResponse,
  loc: { object: string; since: string | null; offset: number },
  version: string,
): void {
  const all = sorted(p.sf.objects[loc.object] ?? []).filter(
    (r) => !loc.since || String(r.LastModifiedDate) > loc.since,
  );
  const slice = all.slice(loc.offset, loc.offset + p.sf.pageSize);
  const nextOffset = loc.offset + p.sf.pageSize;
  const done = nextOffset >= all.length;
  let nextRecordsUrl: string | undefined;
  if (!done) {
    const key = `01g${p.serialize()}`;
    p.locators.set(key, { ...loc, offset: nextOffset });
    nextRecordsUrl = `/services/data/${version}/query/${key}`;
  }
  return json(res, 200, {
    totalSize: all.length,
    done,
    ...(nextRecordsUrl ? { nextRecordsUrl } : {}),
    records: slice.map((r) => ({ attributes: { type: loc.object }, ...r })),
  });
}

function sorted(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...rows].sort((a, b) =>
    String(a.LastModifiedDate).localeCompare(String(b.LastModifiedDate)),
  );
}

/** The bulk CSV: relationship fields flattened (`Owner.Name`), booleans / numbers as text. */
function toCsv(rows: Array<Record<string, unknown>>): string {
  const columns = new Set<string>();
  const flat = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'attributes') continue;
      if (v && typeof v === 'object') {
        for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
          if (ik === 'attributes') continue;
          out[`${k}.${ik}`] = iv === null || iv === undefined ? '' : String(iv);
        }
      } else out[k] = v === null || v === undefined ? '' : String(v);
    }
    for (const k of Object.keys(out)) columns.add(k);
    return out;
  });
  const cols = [...columns];
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    cols.map(cell).join(','),
    ...flat.map((r) => cols.map((c) => cell(r[c] ?? '')).join(',')),
  ].join('\n');
}

/** RS256 over header.claims under the test's public key; iss / sub / aud / exp checked. Empty string = fine. */
function verifyAssertion(sf: FakeSalesforce, assertion: string): string {
  const parts = assertion.split('.');
  if (parts.length !== 3) return 'malformed assertion';
  const [h, c, s] = parts as [string, string, string];
  let header: { alg?: string };
  let claims: { iss?: string; sub?: string; aud?: string; exp?: number };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  } catch {
    return 'unreadable assertion';
  }
  if (header.alg !== 'RS256') return 'alg';
  if (claims.iss !== sf.jwt.clientId) return 'iss';
  if (claims.sub !== sf.jwt.username) return 'sub';
  if (claims.aud !== sf.base) return `aud ${claims.aud}`;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return 'exp';
  if (!sf.jwt.publicKey) return 'no public key on the app';
  const ok = createVerify('RSA-SHA256')
    .update(`${h}.${c}`)
    .verify(sf.jwt.publicKey, Buffer.from(s, 'base64url'));
  return ok ? '' : 'signature';
}

function escapeHtml(v: string): string {
  return v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
