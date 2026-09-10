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
