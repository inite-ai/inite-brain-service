/**
 * MCP /health endpoint — unauthenticated probe
 *
 * - GET /mcp/<anything>/health returns 200 + payload, NO auth header
 * - POST /mcp/<companyId> still requires a valid API key (401 without)
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('MCP /health probe', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_mcp_health_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('returns 200 + ok payload without an Authorization header', async () => {
    const res = await f.http.get('/mcp/whatever-companyId/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.version).toBe('string');
    // Two distinct numbers: the MCP server's own version and the brain
    // release /health reports. Conflating them has cost debugging time.
    expect(typeof res.body.serviceVersion).toBe('string');
    expect(res.body.serviceVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body.tools).toContain('search_knowledge');
    expect(res.body.tools).toContain('memory_diff');
    expect(typeof res.body.embedder).toBe('string');
    expect(res.body.embedder.length).toBeGreaterThan(0);
  });

  it('still rejects unauthenticated POST to the MCP endpoint', async () => {
    const res = await f.http
      .post(`/mcp/${f.companyId}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
  });
});

/**
 * The tenant-less spelling. A client that found brain through OAuth
 * knows the URL and nothing else — the tenant arrives with the token —
 * so `/mcp` has to serve, and its probe has to answer, without a
 * companyId in the path.
 */
describe('MCP endpoint without a tenant in the path', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_mcp_rootpath_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('serves the probe at /mcp/health too', async () => {
    const res = await f.http.get('/mcp/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tools).toContain('search_knowledge');
  });

  it('takes the tenant from the credential', async () => {
    const res = await f.http
      .post('/mcp')
      .set({
        Authorization: `Bearer ${f.apiKey}`,
        Accept: 'application/json, text/event-stream',
      })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    const body = String(res.headers['content-type'] ?? '').includes('text/event-stream')
      ? JSON.parse(
          (res.text ?? '')
            .split('\n')
            .filter((l: string) => l.startsWith('data: '))
            .map((l: string) => l.slice(6))
            .pop() ?? '{}',
        )
      : res.body;
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names).toContain('search_knowledge');
  });

  it('still refuses an unauthenticated call that reaches memory', async () => {
    // `tools/list` is one of the messages an anonymous caller MAY send
    // (public-tools.ts); a tool that reads a tenant is not, and its
    // refusal keeps the challenge an OAuth client starts from.
    const res = await f.http.post('/mcp').send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_knowledge', arguments: { query: 'anything' } },
    });
    expect(res.status).toBe(401);
    // The 401 names the discovery document, so a client can self-onboard.
    // Claude requires its `resource` to equal the URL entered — `/mcp`.
    const challenge = String(res.headers['www-authenticate'] ?? '');
    expect(challenge).toContain('/.well-known/oauth-protected-resource/mcp"');
    expect(challenge).toContain('scope="brain:read brain:write"');
  });

  // Lazy authentication: a client calls only tools it saw listed, and the
  // 401 on that call is what starts its sign-in.
  it('lists the memory tools to an anonymous caller, beside the public ones', async () => {
    const res = await f.http
      .post('/mcp')
      .set({ Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const body = String(res.headers['content-type'] ?? '').includes('text/event-stream')
      ? JSON.parse(
          (res.text ?? '')
            .split('\n')
            .filter((l: string) => l.startsWith('data: '))
            .map((l: string) => l.slice(6))
            .pop() ?? '{}',
        )
      : res.body;
    const names = (body.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining(['about_brain', 'how_to_connect', 'search_knowledge', 'record_fact']),
    );
    expect(names).not.toContain('forget_entity');
  });
});
