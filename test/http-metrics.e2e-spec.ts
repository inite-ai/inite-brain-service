/**
 * Request RED metrics end to end (docs/slo.md): a REST call, a rejected
 * call and an MCP tool call all land on /metrics, under their route
 * templates and the tool's name and outcome.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('request metrics on /metrics (e2e)', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_http_metrics_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const scrape = async () => (await f.http.get('/metrics')).text;
  /**
   * A request is recorded on the server response's 'finish' event, and the
   * client runs in the same process: it can read the response before that
   * callback has run. Scrape until `ready` holds, briefly, instead of
   * reading once.
   */
  const scrapeUntil = async (ready: (body: string) => boolean): Promise<string> => {
    let body = await scrape();
    for (let i = 0; i < 20 && !ready(body); i++) {
      await new Promise((r) => setTimeout(r, 50));
      body = await scrape();
    }
    return body;
  };
  /** The sample of `name` carrying every label in `labels` (any order, plus `instance`). */
  const value = (body: string, name: string, labels: Record<string, string>) => {
    const line = body
      .split('\n')
      .find(
        (l) =>
          l.startsWith(`${name}{`) &&
          Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)),
      );
    return line ? Number(line.split(' ').pop()) : 0;
  };

  it('counts REST requests by route template and status class', async () => {
    await f.http.get('/v1/facts/knowledge_fact:nope').set({ Authorization: `Bearer ${f.apiKey}` });
    await f.http.get('/v1/facts/knowledge_fact:nope');
    const counted = (b: string) =>
      value(b, 'brain_http_requests_total', {
        method: 'GET',
        route: '/v1/facts/:id',
        status_class: '4xx',
      });
    const body = await scrapeUntil((b) => counted(b) >= 2);
    // On a miss, show every series of the route: a wrong label reads at once.
    const series = body
      .split('\n')
      .filter((l) => l.startsWith('brain_http_requests_total{') && l.includes('/v1/facts'));
    expect(counted(body) >= 2 ? 'counted' : series).toBe('counted');
    expect(
      value(body, 'brain_http_request_duration_seconds_bucket', {
        le: '5',
        route: '/v1/facts/:id',
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/route="\/v1\/facts\/knowledge_fact/);
  });

  it('counts an MCP tool call by tool and outcome', async () => {
    const res = await f.http
      .post(`/mcp/${f.companyId}`)
      .set({
        Authorization: `Bearer ${f.apiKey}`,
        Accept: 'application/json, text/event-stream',
      })
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'workspace_status', arguments: {} },
      });
    expect(res.status).toBe(200);
    const body = await scrape();
    expect(
      value(body, 'brain_mcp_tool_calls_total', { tool: 'workspace_status', outcome: 'ok' }),
    ).toBe(1);
    expect(
      value(body, 'brain_http_requests_total', { method: 'POST', route: '/mcp/:companyId' }),
    ).toBeGreaterThanOrEqual(1);
  });
});
