/**
 * The onboarding surface, end to end: an agent that has just connected
 * can ask what it is attached to, name it, and then stop being offered
 * the naming tool.
 *
 * The disappearing act is the part worth testing against a real server:
 * tools are registered per request, so "the surface shrinks as setup
 * completes" is a claim about buildServer, not about a helper.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('onboarding tools', () => {
  let f: AppFixture;

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_onboarding_e2e',
      scopes: ['brain:read', 'brain:write'],
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  function parseSse(text: string): Record<string, any> {
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    return events[events.length - 1] ?? {};
  }

  async function rpc(body: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await f.http
      .post(`/mcp/${f.companyId}`)
      .set({
        Authorization: `Bearer ${f.apiKey}`,
        Accept: 'application/json, text/event-stream',
      })
      .send(body);
    expect(res.status).toBe(200);
    return String(res.headers['content-type'] ?? '').includes('text/event-stream')
      ? parseSse(res.text ?? '')
      : res.body;
  }

  const toolNames = async (): Promise<string[]> => {
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return (out.result?.tools ?? []).map((t: { name: string }) => t.name);
  };

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });

  it('offers both tools while the workspace is unnamed', async () => {
    const names = await toolNames();
    expect(names).toContain('workspace_status');
    expect(names).toContain('rename_workspace');
  });

  it('reports the tenant and what is left to do', async () => {
    const out = await call('workspace_status');
    const status = out.result?.structuredContent;

    expect(status.companyId).toBe('co_onboarding_e2e');
    expect(status.displayName).toBeUndefined();
    expect(status.memory).toEqual(
      expect.objectContaining({ entities: expect.any(Number), facts: expect.any(Number) }),
    );
    // A fresh tenant has something to do: it is unnamed and empty.
    expect(status.nextSteps.length).toBeGreaterThan(0);
    expect(status.nextSteps[0]).toContain('rename_workspace');
  });

  it('names the workspace, and stops offering to', async () => {
    const renamed = await call('rename_workspace', { name: 'Acme support memory' });
    expect(renamed.result?.structuredContent?.displayName).toBe('Acme support memory');

    const names = await toolNames();
    expect(names).toContain('workspace_status');
    expect(names).not.toContain('rename_workspace');

    const status = (await call('workspace_status')).result?.structuredContent;
    expect(status.displayName).toBe('Acme support memory');
    expect(status.nextSteps.join(' ')).not.toContain('rename_workspace');
  });
});
