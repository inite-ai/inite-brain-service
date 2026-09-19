import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * One loopback server that plays a hosted MCP server that SIGNS IN
 * (W4.3) and its authorization server: `/mcp` answers 401 with the
 * RFC 9728 challenge until a bearer it minted arrives, then serves
 * resources (the SDK's McpServer, stateless); the protected-resource
 * metadata at the path-aware well-known; the authorization server at
 * `/auth` (RFC 8414 metadata, RFC 7591 registration, an "Allow" page,
 * a PKCE token endpoint, revocation). Knobs: whether registration is
 * offered, how long tokens live, what the resource says it needs.
 */
export interface FakeMcpOAuth {
  base: string;
  /** The MCP server URL an operator names. */
  serverUrl: string;
  close(): Promise<void>;
  calls: Array<{ method: string; path: string; auth: string | null; body: string }>;
  registration: boolean;
  /** Seconds a minted access token lives. */
  expiresIn: number;
  scopes: string[];
  /** Clients registered dynamically (id → secret or null) and the codes / tokens minted. */
  clients: Map<string, string | null>;
  codes: Map<string, { clientId: string; challenge: string }>;
  tokens: Set<string>;
  revoked: string[];
  resources: Array<{ uri: string; title: string; text: string; modified: string }>;
}

export async function startFakeMcpOAuth(): Promise<FakeMcpOAuth> {
  let serial = 0;
  const f: FakeMcpOAuth = {
    base: '',
    serverUrl: '',
    close: async () => undefined,
    calls: [],
    registration: true,
    expiresIn: 3600,
    scopes: ['resources:read'],
    clients: new Map(),
    codes: new Map(),
    tokens: new Set(),
    revoked: [],
    resources: [
      {
        uri: 'wiki://pages/intro',
        title: 'Intro',
        text: '# Intro\nAcme was founded in 2019 in Tallinn.',
        modified: '2026-03-01T10:00:00Z',
      },
    ],
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
      route({ f, req, res, body, next: () => ++serial }).catch((e) =>
        json(res, 500, { error: (e as Error).message }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  f.base = `http://127.0.0.1:${port}`;
  f.serverUrl = `${f.base}/mcp`;
  f.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return f;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function route(p: {
  f: FakeMcpOAuth;
  req: IncomingMessage;
  res: ServerResponse;
  body: string;
  next: () => number;
}): Promise<void> {
  const { f, req, res, body } = p;
  const url = new URL(req.url ?? '/', f.base);
  const path = url.pathname;
  const m = req.method ?? 'GET';
  // ── the resource server ──
  if (path === '/.well-known/oauth-protected-resource/mcp') {
    return json(res, 200, {
      resource: f.serverUrl,
      authorization_servers: [`${f.base}/auth`],
      scopes_supported: f.scopes,
      bearer_methods_supported: ['header'],
    });
  }
  if (path === '/mcp') {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer || !f.tokens.has(bearer)) {
      return json(
        res,
        401,
        { error: 'unauthorized' },
        {
          'www-authenticate': `Bearer realm="mcp", resource_metadata="${f.base}/.well-known/oauth-protected-resource/mcp"`,
        },
      );
    }
    return serveMcp(f, req, res, body);
  }
  // ── the authorization server ──
  if (path === '/.well-known/oauth-authorization-server/auth') {
    return json(res, 200, {
      issuer: `${f.base}/auth`,
      authorization_endpoint: `${f.base}/auth/authorize`,
      token_endpoint: `${f.base}/auth/token`,
      ...(f.registration ? { registration_endpoint: `${f.base}/auth/register` } : {}),
      revocation_endpoint: `${f.base}/auth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: f.scopes,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  }
  if (path === '/auth/register' && m === 'POST') {
    if (!f.registration) return json(res, 404, { error: 'not_found' });
    const parsed = JSON.parse(body) as {
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
      client_name?: string;
    };
    if (!parsed.redirect_uris?.length) return json(res, 400, { error: 'invalid_redirect_uri' });
    const id = `dcr_${p.next()}`;
    const secret = parsed.token_endpoint_auth_method === 'none' ? null : `sec_${p.next()}`;
    f.clients.set(id, secret);
    return json(res, 201, {
      client_id: id,
      ...(secret ? { client_secret: secret } : {}),
      client_name: parsed.client_name,
      redirect_uris: parsed.redirect_uris,
      token_endpoint_auth_method: parsed.token_endpoint_auth_method ?? 'none',
    });
  }
  if (path === '/auth/authorize' && m === 'GET') {
    const clientId = url.searchParams.get('client_id') ?? '';
    if (!f.clients.has(clientId)) return json(res, 400, { error: 'invalid_client' });
    if (url.searchParams.get('resource') !== f.serverUrl)
      return json(res, 400, { error: 'invalid_target', got: url.searchParams.get('resource') });
    const challenge = url.searchParams.get('code_challenge') ?? '';
    if (!challenge || url.searchParams.get('code_challenge_method') !== 'S256')
      return json(res, 400, { error: 'pkce required' });
    const code = `code_${p.next()}`;
    f.codes.set(code, { clientId, challenge });
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><body><h2>Fake MCP AS</h2><p>scope: <code>${url.searchParams.get('scope') ?? ''}</code></p><p><a id="allow" href="${back.toString().replace(/&/g, '&amp;')}">Allow</a></p></body></html>`,
    );
    return;
  }
  if (path === '/auth/token' && m === 'POST') {
    const params = new URLSearchParams(body);
    const clientId = params.get('client_id') ?? '';
    if (!f.clients.has(clientId)) return json(res, 401, { error: 'invalid_client' });
    const secret = f.clients.get(clientId);
    if (secret && params.get('client_secret') !== secret)
      return json(res, 401, { error: 'invalid_client', error_description: 'secret' });
    if (params.get('resource') !== f.serverUrl) return json(res, 400, { error: 'invalid_target' });
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      const code = f.codes.get(params.get('code') ?? '');
      if (!code || code.clientId !== clientId) return json(res, 400, { error: 'invalid_grant' });
      const verifier = params.get('code_verifier') ?? '';
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (expected !== code.challenge)
        return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
      f.codes.delete(params.get('code') ?? '');
    } else if (grant === 'refresh_token') {
      if (!params.get('refresh_token')?.startsWith('mrt_'))
        return json(res, 400, { error: 'invalid_grant' });
    } else return json(res, 400, { error: 'unsupported_grant_type' });
    const access = `mtok_${p.next()}`;
    f.tokens.add(access);
    return json(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: f.expiresIn,
      refresh_token: `mrt_${access}`,
      scope: f.scopes.join(' '),
    });
  }
  if (path === '/auth/revoke' && m === 'POST') {
    f.revoked.push(new URLSearchParams(body).get('token') ?? '');
    return json(res, 200, {});
  }
  return json(res, 404, { error: `no route ${m} ${path}` });
}

async function serveMcp(
  f: FakeMcpOAuth,
  req: IncomingMessage,
  res: ServerResponse,
  raw: string,
): Promise<void> {
  const mcp = new McpServer({ name: 'fake-signed-in-mcp', version: '0.0.1' });
  for (const r of f.resources) {
    mcp.registerResource(
      r.uri,
      r.uri,
      { title: r.title, mimeType: 'text/markdown', annotations: { lastModified: r.modified } },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: r.text }],
      }),
    );
  }
  const transport = new StreamableHTTPServerTransport({});
  res.on('close', () => {
    transport.close().catch(() => undefined);
    mcp.close().catch(() => undefined);
  });
  await mcp.connect(transport as Transport);
  await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
}
