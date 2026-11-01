/**
 * Runtime scope challenge over MCP (2025-11-25 authorization, "Scope
 * Challenge Handling"): a read-only token calling a write tool gets a 403
 * whose WWW-Authenticate names insufficient_scope, the scopes to step up
 * to and the resource metadata; a read tool still answers; a token that
 * holds the scope is never challenged.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { requiredScopeOf } from '../src/mcp/gated-catalogue';

describe('MCP insufficient_scope challenge (e2e)', () => {
  let f: AppFixture;
  let readOnly: string;

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_mcp_scope_e2e',
      extraKeys: [{ scopes: ['brain:read'] }],
    });
    readOnly = f.extraApiKeys[0]!;
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  const call = (key: string, name: string, args: Record<string, unknown>) =>
    f.http
      .post(`/mcp/${f.companyId}`)
      .set({ Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  it('classifies tools by the scope buildServer registers them under', () => {
    expect(requiredScopeOf('record_fact')).toBe('brain:write');
    expect(requiredScopeOf('record_feedback')).toBe('brain:write');
    expect(requiredScopeOf('forget_entity')).toBe('brain:admin');
    expect(requiredScopeOf('search_knowledge')).toBeNull();
  });

  it('a read-only token calling a write tool is challenged to step up', async () => {
    const res = await call(readOnly, 'record_fact', {
      entityRef: { vertical: 'rent', id: 'scope_probe' },
      predicate: 'tier',
      object: 'gold',
      validFrom: '2026-01-01T00:00:00Z',
      sourceVertical: 'rent',
    });
    expect(res.status).toBe(403);
    const challenge = String(res.headers['www-authenticate']);
    expect(challenge).toMatch(/^Bearer error="insufficient_scope"/);
    expect(challenge).toContain('scope="brain:read brain:write"');
    expect(challenge).toMatch(/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource/);
  });

  it('a read tool still answers the read-only token, and a write token is not challenged', async () => {
    const read = await call(readOnly, 'workspace_status', {});
    expect(read.status).toBe(200);
    const write = await call(f.apiKey, 'record_fact', {
      entityRef: { vertical: 'rent', id: 'scope_probe' },
      predicate: 'tier',
      object: 'gold',
      validFrom: '2026-01-01T00:00:00Z',
      sourceVertical: 'rent',
    });
    expect(write.status).toBe(200);
    expect(write.headers['www-authenticate']).toBeUndefined();
  });
});
