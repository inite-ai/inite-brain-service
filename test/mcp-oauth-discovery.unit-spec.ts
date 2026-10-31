/**
 * The MCP authorization discovery (W4.3) against the fake: the 401's
 * `resource_metadata` challenge, the path-aware well-known fallbacks, the
 * authorization server's metadata, dynamic registration as a public
 * PKCE client (or with a secret when the server insists), and the
 * canonical resource.
 */
import {
  authorizationServerMetadata,
  canonicalResource,
  discoverMcpAuth,
  registerClient,
  resourceMetadataUrlOf,
} from '../src/source-plane/oauth/mcp-oauth-discovery';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeMcpOAuth, type FakeMcpOAuth } from './fixtures/fake-mcp-oauth';

describe('mcp oauth discovery', () => {
  let mcp: FakeMcpOAuth;
  const saved = process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
  beforeAll(async () => {
    mcp = await startFakeMcpOAuth();
    process.env.SOURCE_EGRESS_ALLOW_PRIVATE = '1';
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    else process.env.SOURCE_EGRESS_ALLOW_PRIVATE = saved;
    await mcp.close();
  });

  it('parses the WWW-Authenticate challenge and canonicalises the resource', () => {
    expect(
      resourceMetadataUrlOf(
        'Bearer realm="x", resource_metadata="https://s.test/.well-known/oauth-protected-resource/mcp"',
      ),
    ).toBe('https://s.test/.well-known/oauth-protected-resource/mcp');
    expect(resourceMetadataUrlOf('Bearer realm="x"')).toBeNull();
    expect(resourceMetadataUrlOf(null)).toBeNull();
    expect(canonicalResource('https://s.test/mcp/#frag')).toBe('https://s.test/mcp');
    expect(canonicalResource('https://s.test/')).toBe('https://s.test');
  });

  it('follows the 401 to the protected-resource metadata and the authorization server, and registers a public client', async () => {
    const d = await discoverMcpAuth(mcp.serverUrl, { allowPrivate: true });
    expect(d.resource).toBe(mcp.serverUrl);
    expect(d.prm).toMatchObject({
      authorizationServers: [`${mcp.base}/auth`],
      scopesSupported: ['resources:read'],
    });
    expect(d.as).toMatchObject({
      issuer: `${mcp.base}/auth`,
      authorizationEndpoint: `${mcp.base}/auth/authorize`,
      tokenEndpoint: `${mcp.base}/auth/token`,
      registrationEndpoint: `${mcp.base}/auth/register`,
      codeChallengeMethods: ['S256'],
    });
    const client = await registerClient(
      d.as,
      {
        redirectUri: 'https://brain.test/cb',
        clientName: 'INITE Brain',
        scopes: d.prm!.scopesSupported,
      },
      { allowPrivate: true },
    );
    expect(client.clientId).toMatch(/^dcr_/);
    expect(client).toMatchObject({ clientSecret: null, tokenAuth: 'none' });
    expect(mcp.clients.get(client.clientId)).toBeNull();
  });

  it('refuses a server without metadata by name; names a missing registration endpoint', async () => {
    await expect(discoverMcpAuth(`${mcp.base}/nowhere`, { allowPrivate: true })).rejects.toThrow(
      /no authorization server metadata/,
    );
    await expect(
      authorizationServerMetadata(`${mcp.base}/nope`, { allowPrivate: true }),
    ).rejects.toThrow(/publishes no authorization server metadata/);
    const d = await discoverMcpAuth(mcp.serverUrl, { allowPrivate: true });
    await expect(
      registerClient(
        { ...d.as, registrationEndpoint: null },
        { redirectUri: 'https://b/cb', clientName: 'x', scopes: [] },
        { allowPrivate: true },
      ),
    ).rejects.toThrow(/no dynamic client registration/);
  });

  it('ignores metadata naming another issuer, and refuses a server without PKCE', async () => {
    let doc: Record<string, unknown> = {};
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endpoints = { authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t` };
    try {
      // RFC 8414 §3.3: an issuer other than the one asked for is not used.
      doc = {
        ...endpoints,
        issuer: 'https://evil.example',
        code_challenge_methods_supported: ['S256'],
      };
      await expect(authorizationServerMetadata(base, { allowPrivate: true })).rejects.toThrow(
        /publishes no authorization server metadata/,
      );
      // MCP authorization: no S256 advertised → refuse.
      doc = { ...endpoints, issuer: base };
      await expect(authorizationServerMetadata(base, { allowPrivate: true })).rejects.toThrow(
        /does not advertise PKCE/,
      );
      doc = { ...endpoints, issuer: `${base}/`, code_challenge_methods_supported: ['S256'] };
      await expect(
        authorizationServerMetadata(base, { allowPrivate: true }),
      ).resolves.toMatchObject({
        tokenEndpoint: `${base}/t`,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('never reaches a private host without the double opt-in', async () => {
    await expect(discoverMcpAuth(mcp.serverUrl, { allowPrivate: false })).rejects.toThrow(
      /no authorization server metadata/,
    );
    expect(mcp.calls.filter((c) => c.path === '/mcp').length).toBeGreaterThan(0);
  });
});
