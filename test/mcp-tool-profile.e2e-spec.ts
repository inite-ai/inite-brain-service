/**
 * The profile knob, over the wire.
 *
 * The unit spec proves the gate and the meta pair. This proves the one
 * thing only a real request can: that `?tools=core` on the URL — the
 * single field a one-click connector ever hands a user — reaches
 * buildServer, and that a typo in it is a 400 rather than a silent
 * fallback to the full surface.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

/** tools/list over Streamable HTTP, which may answer as SSE. */
function toolNames(res: { headers: Record<string, string>; text?: string; body: unknown }) {
  const body = String(res.headers['content-type'] ?? '').includes('text/event-stream')
    ? JSON.parse(
        (res.text ?? '')
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .pop() ?? '{}',
      )
    : (res.body as Record<string, unknown>);
  const result = (body as { result?: { tools?: { name: string }[] } }).result;
  return (result?.tools ?? []).map((t) => t.name);
}

describe('MCP tool profiles over HTTP', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_profile_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const list = (query: string) =>
    f.http
      .post(`/mcp${query}`)
      .set({ Authorization: `Bearer ${f.apiKey}`, Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

  it('serves the full surface by default', async () => {
    const res = await list('');
    expect(res.status).toBe(200);
    const names = toolNames(res);
    expect(names).toContain('search_knowledge');
    expect(names).toContain('get_competing_facts');
    expect(names).not.toContain('find_tool');
  });

  it('narrows to the core surface on ?tools=core', async () => {
    const res = await list('?tools=core');
    expect(res.status).toBe(200);
    const names = toolNames(res);
    expect(names).toContain('search_knowledge');
    expect(names).toContain('find_tool');
    expect(names).toContain('run_tool');
    expect(names).not.toContain('get_competing_facts');
    expect(names.length).toBeLessThan(10);
  });

  it('reaches an unlisted tool through run_tool', async () => {
    const res = await f.http
      .post('/mcp?tools=core')
      .set({ Authorization: `Bearer ${f.apiKey}`, Accept: 'application/json, text/event-stream' })
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'run_tool', arguments: { name: 'list_procedures', args: {} } },
      });
    expect(res.status).toBe(200);
    const text = res.text ?? JSON.stringify(res.body);
    // The tenant is empty, so the real answer is an empty list — what
    // matters is that dispatch reached the handler rather than erroring
    // with "unknown tool".
    expect(text).not.toContain('unknown tool');
  });

  it('answers the health probe for the profile it was asked about', async () => {
    const full = await f.http.get('/mcp/health');
    expect(full.status).toBe(200);
    expect(full.body.profile).toBe('full');

    const core = await f.http.get('/mcp/health?tools=core');
    expect(core.status).toBe(200);
    expect(core.body.profile).toBe('core');
    expect(core.body.tools).toContain('find_tool');
    expect(core.body.tools.length).toBeLessThan(full.body.tools.length);
  });

  it('rejects a typo instead of quietly serving everything', async () => {
    const res = await list('?tools=coer');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('unknown tool profile');
  });
});
