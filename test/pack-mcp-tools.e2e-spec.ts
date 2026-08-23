/**
 * Pack-declared MCP tools — end-to-end on a real DB (docs/mcp-pack-tools.md).
 *
 * Full loop: install a pack whose manifest ships mcpTools (consent gate →
 * 400 without acceptMcpTools), see the tools in tools/list as
 * `<packId>__<name>`, call the facts_by_predicate query tool over
 * ingested facts, verify the PII row fence against a plain brain:read
 * key, call the external tool against a REAL local http server (HMAC
 * verified with the install webhookSecret; installId — not companyId —
 * on the wire), re-consent on a changed section, and uninstall.
 *
 * Flags are set BEFORE createApp; MCP_PACK_TOOLS_ALLOW_HTTP permits the
 * loopback endpoint for the external-tool leg.
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AppFixture } from './app-fixture';

process.env.MCP_PACK_TOOLS_ENABLED = '1';
process.env.MCP_PACK_EXTERNAL_TOOLS_ENABLED = '1';
process.env.MCP_PACK_TOOLS_ALLOW_HTTP = '1';

// Import AFTER the env flags so nothing captures them un-set at load.
import { createApp } from './app-fixture';

describe('pack-declared MCP tools (e2e)', () => {
  let f: AppFixture;
  let endpointServer: http.Server;
  let endpointPort = 0;
  let webhookSecret = '';
  const endpointHits: Array<{
    signature: string;
    body: string;
    verified: boolean;
  }> = [];

  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const manifest = (over: Record<string, unknown> = {}) => ({
    id: 'compliance',
    version: '1.0.0',
    description: 'Compliance test pack (MCP tools e2e).',
    predicates: [
      {
        localId: 'violation',
        displayLabel: 'violation',
        description: 'TYPE subject is a company; value is a recorded violation',
        datatype: 'string',
        semantics: 'append_only',
        decayHalfLifeDays: null,
        piiClass: 'none',
        status: 'active',
      },
      {
        localId: 'sanction_status',
        displayLabel: 'sanction status',
        description: 'TYPE subject is a company; value is a sanction finding',
        datatype: 'string',
        semantics: 'append_only',
        decayHalfLifeDays: null,
        piiClass: 'sensitive',
        requiresScope: 'brain:read_pii',
        status: 'active',
      },
    ],
    mcpTools: [
      {
        kind: 'query',
        name: 'find_violations',
        title: 'Find recorded violations',
        description: 'List facts recorded by the compliance pack.',
        query: {
          surface: 'facts_by_predicate',
          predicates: ['violation', 'sanction_status'],
          defaultLimit: 10,
        },
      },
      {
        kind: 'external',
        name: 'check_sanctions',
        description: 'Screen a counterparty against the publisher backend.',
        endpoint: `http://127.0.0.1:${endpointPort}/tool`,
        timeoutMs: 5_000,
        params: [
          { name: 'counterparty', type: 'string', required: true, maxLength: 200 },
        ],
      },
    ],
    ...over,
  });

  // ── JSON-RPC over the stateless Streamable HTTP endpoint ──────────
  function parseSse(text: string): any {
    const events: any[] = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
    return events[events.length - 1];
  }

  async function rpc(key: string, body: Record<string, unknown>): Promise<any> {
    const res = await f.http
      .post(`/mcp/${f.companyId}`)
      .set({
        Authorization: `Bearer ${key}`,
        Accept: 'application/json, text/event-stream',
      })
      .send(body);
    expect(res.status).toBe(200);
    const ct = String(res.headers['content-type'] ?? '');
    if (ct.includes('text/event-stream')) {
      return parseSse(res.text ?? res.body.toString());
    }
    return res.body;
  }

  const toolsList = async (key: string): Promise<string[]> => {
    const out = await rpc(key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    return (out.result?.tools ?? []).map((t: { name: string }) => t.name);
  };

  const toolCall = async (
    key: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> => {
    const out = await rpc(key, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return out.result;
  };

  beforeAll(async () => {
    endpointServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const signature = String(req.headers['x-brain-signature'] ?? '');
        const expected =
          'sha256=' +
          createHmac('sha256', webhookSecret).update(body).digest('hex');
        endpointHits.push({ signature, body, verified: signature === expected });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: { verdict: 'clean', hits: 0 } }));
      });
    });
    await new Promise<void>((resolve) =>
      endpointServer.listen(0, '127.0.0.1', resolve),
    );
    endpointPort = (endpointServer.address() as { port: number }).port;

    f = await createApp({
      companyId: 'co_pack_mcp_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii'],
      // A plain reader key — the PII row-fence leg.
      extraKeys: [{ scopes: ['brain:read'] }],
    });
  }, 120_000);

  afterAll(async () => {
    if (f) await f.close();
    if (endpointServer) {
      await new Promise((resolve) => endpointServer.close(resolve));
    }
  });

  it('rejects installing a pack with mcpTools without acceptMcpTools (listing the tools)', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest() });
    expect(r.status).toBe(400);
    const msg = JSON.stringify(r.body);
    expect(msg).toContain('acceptMcpTools');
    expect(msg).toContain('find_violations');
    expect(msg).toContain('check_sanctions');
  });

  it('installs with acceptMcpTools: true and mints a webhookSecret', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest(), acceptMcpTools: true });
    expect([200, 201]).toContain(r.status);
    expect(typeof r.body.webhookSecret).toBe('string');
    webhookSecret = r.body.webhookSecret;
  });

  it('tools/list shows the namespaced pack tools with the server preamble', async () => {
    const names = await toolsList(f.apiKey);
    expect(names).toContain('compliance__find_violations');
    expect(names).toContain('compliance__check_sanctions');

    const out = await rpc(f.apiKey, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    });
    const tool = out.result.tools.find(
      (t: { name: string }) => t.name === 'compliance__find_violations',
    );
    expect(tool.description).toMatch(
      /^\[third-party tool from domain pack "compliance" v1\.0\.0;/,
    );
  });

  it('the query tool returns ingested facts', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'crm', id: 'acme' },
        predicate: 'compliance__violation',
        object: 'late filing 2026-Q1',
        validFrom: '2026-07-01T00:00:00Z',
        source: { vertical: 'crm' },
      });
    expect([200, 201]).toContain(ingest.status);

    const result = await toolCall(f.apiKey, 'compliance__find_violations', {
      predicate: 'violation',
    });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent;
    expect(out.predicate).toBe('compliance__violation');
    expect(out.found).toBeGreaterThanOrEqual(1);
    expect(
      out.facts.some(
        (x: { object: string }) => x.object === 'late filing 2026-Q1',
      ),
    ).toBe(true);
  });

  it('row-fences a requiresScope pack predicate from a plain brain:read key', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'crm', id: 'acme' },
        predicate: 'compliance__sanction_status',
        object: 'OFAC list hit',
        validFrom: '2026-07-01T00:00:00Z',
        source: { vertical: 'crm' },
      });
    expect([200, 201]).toContain(ingest.status);

    // Privileged key (brain:read_pii) sees the fact…
    const privileged = await toolCall(f.apiKey, 'compliance__find_violations', {
      predicate: 'sanction_status',
    });
    expect(privileged.structuredContent.found).toBeGreaterThanOrEqual(1);

    // …the plain brain:read key gets zero rows from the SAME tool.
    const plain = await toolCall(
      f.extraApiKeys[0]!,
      'compliance__find_violations',
      { predicate: 'sanction_status' },
    );
    expect(plain.structuredContent.found).toBe(0);
  });

  it('proxies the external tool: HMAC verifies, installId (not companyId) on the wire', async () => {
    const result = await toolCall(f.apiKey, 'compliance__check_sanctions', {
      counterparty: 'Acme GmbH',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ verdict: 'clean', hits: 0 });

    expect(endpointHits).toHaveLength(1);
    const hit = endpointHits[0]!;
    expect(hit.verified).toBe(true);
    const body = JSON.parse(hit.body);
    expect(body).toMatchObject({
      event: 'mcp_tool_call',
      tool: 'check_sanctions',
      packId: 'compliance',
      args: { counterparty: 'Acme GmbH' },
    });
    expect(typeof body.installId).toBe('string');
    expect(body.companyId).toBeUndefined();
    expect(hit.body).not.toContain(f.companyId);
  });

  it('an upgrade with an UNCHANGED mcpTools section carries consent over', async () => {
    const r = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest({ version: '1.0.1' }) });
    expect([200, 201]).toContain(r.status);
    // Secret survives the upgrade (no re-mint → not in the response).
    expect(r.body.webhookSecret).toBeUndefined();
  });

  it('an upgrade with a CHANGED mcpTools section re-requires consent', async () => {
    const changed = manifest({ version: '1.0.2' }) as any;
    changed.mcpTools[0].description = 'Now with different behaviour.';
    const denied = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: changed });
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.body)).toContain('acceptMcpTools');

    const accepted = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: changed, acceptMcpTools: true });
    expect([200, 201]).toContain(accepted.status);
  });

  it('uninstall removes the pack tools from tools/list', async () => {
    const del = await f.http.delete('/v1/admin/packs/compliance').set(auth());
    expect(del.status).toBe(200);
    const names = await toolsList(f.apiKey);
    expect(names).not.toContain('compliance__find_violations');
    expect(names).not.toContain('compliance__check_sanctions');
    // The static families are untouched.
    expect(names).toContain('search_knowledge');
  });
});
