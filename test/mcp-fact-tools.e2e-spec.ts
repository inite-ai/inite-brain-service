/**
 * MCP fact read tools — end-to-end on a real DB.
 *
 * The 0115 trust loop over MCP: record_fact with evidence[] (under
 * EVIDENCE_GROUNDING_STAMP=1) → get_fact shows groundingStatus →
 * get_fact_provenance returns the passthrough provenance shape. Plus
 * gating parity with REST: FACTS_API_ENABLED off removes the tools from
 * tools/list and a blind tools/call errors — the MCP twin of the
 * controller's 404 ("indistinguishable from an absent route") — and the
 * per-request server build means the flag flips without a restart,
 * exactly like the REST gate.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

describe('MCP get_fact / get_fact_provenance (e2e)', () => {
  let f: AppFixture;
  const SAVED = {
    factsApi: process.env.FACTS_API_ENABLED,
    stamp: process.env.EVIDENCE_GROUNDING_STAMP,
  };

  beforeAll(async () => {
    process.env.FACTS_API_ENABLED = '1';
    process.env.EVIDENCE_GROUNDING_STAMP = '1';
    f = await createApp({ companyId: 'co_mcp_fact_tools_e2e' });
  }, 120_000);

  afterAll(async () => {
    if (SAVED.factsApi === undefined) delete process.env.FACTS_API_ENABLED;
    else process.env.FACTS_API_ENABLED = SAVED.factsApi;
    if (SAVED.stamp === undefined) delete process.env.EVIDENCE_GROUNDING_STAMP;
    else process.env.EVIDENCE_GROUNDING_STAMP = SAVED.stamp;
    if (f) await f.close();
  });

  // ── JSON-RPC over the stateless Streamable HTTP endpoint ──────────
  function parseSse(text: string): any {
    const events: any[] = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
    return events[events.length - 1];
  }

  async function rpc(body: Record<string, unknown>): Promise<any> {
    const res = await f.http
      .post(`/mcp/${f.companyId}`)
      .set({
        Authorization: `Bearer ${f.apiKey}`,
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

  const toolsList = async (): Promise<string[]> => {
    const out = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    return (out.result?.tools ?? []).map((t: { name: string }) => t.name);
  };

  const toolCall = async (name: string, args: Record<string, unknown>): Promise<any> => {
    return rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  };

  let factId = '';

  it('tools/list shows get_fact + get_fact_provenance under FACTS_API_ENABLED', async () => {
    const names = await toolsList();
    expect(names).toContain('get_fact');
    expect(names).toContain('get_fact_provenance');
  });

  it('record_fact with evidence[] → get_fact shows groundingStatus grounded', async () => {
    const recorded = await toolCall('record_fact', {
      entityRef: { vertical: 'rent', id: 'cust_mcp_fact_1' },
      predicate: 'complained_about',
      object: 'observation recorded over MCP',
      validFrom: '2026-04-01T00:00:00.000Z',
      confidence: 0.7,
      sourceVertical: 'rent',
      evidence: [{ kind: 'message', ref: 'msg_mcp_ev_1' }],
    });
    expect(recorded.result.isError).toBeFalsy();
    expect(recorded.result.structuredContent.outcome).toBe('INSERTED');
    factId = recorded.result.structuredContent.factId;
    expect(typeof factId).toBe('string');

    const read = await toolCall('get_fact', { factId });
    expect(read.result.isError).toBeFalsy();
    const fact = read.result.structuredContent;
    expect(fact.factId).toBe(factId);
    expect(fact.aspect).toBe('complained_about');
    expect(fact.statement).toBe('observation recorded over MCP');
    expect(fact.retracted).toBe(false);
    // The evidence[] pointer marked the claim grounded at ingest; the
    // MCP read surfaces the stamp exactly as GET /v1/facts/:id does.
    expect(fact.groundingStatus).toBe('grounded');
  });

  it('get_fact matches the REST twin byte-for-byte (same service, same fences)', async () => {
    const mcp = await toolCall('get_fact', { factId });
    const rest = await f.http
      .get(`/v1/facts/${encodeURIComponent(factId)}`)
      .set({ Authorization: `Bearer ${f.apiKey}` });
    expect(rest.status).toBe(200);
    expect(mcp.result.structuredContent).toEqual(rest.body);
  });

  it('get_fact_provenance returns the passthrough provenance shape', async () => {
    const out = await toolCall('get_fact_provenance', { factId });
    expect(out.result.isError).toBeFalsy();
    const prov = out.result.structuredContent;
    expect(prov.factId).toBe(factId);
    // Evidence-grounded fact, no derivation episodes: empty list, and no
    // closure keys (PROVENANCE_RECURSIVE_CLOSURE off → byte-identical).
    expect(Array.isArray(prov.episodes)).toBe(true);
    expect(prov.episodes).toEqual([]);
    expect('derivedFacts' in prov).toBe(false);
  });

  it('an unknown factId surfaces the REST-parity not-found error, not a raw DB error', async () => {
    const out = await toolCall('get_fact', { factId: 'knowledge_fact:does_not_exist' });
    // The NotFoundException (HttpException < 500) passes the MCP error
    // wrapper unchanged — the deliberate client-facing class — and the
    // SDK folds a thrown handler error into an isError tool result. A
    // raw Surreal message (record ids, index names) must never appear.
    expect(out.result.isError).toBe(true);
    const text = String(out.result.content?.[0]?.text ?? '');
    expect(text).toContain('not found');
    expect(text.toLowerCase()).not.toContain('surreal');
  });

  it('FACTS_API_ENABLED off → tools vanish from tools/list and a blind call errors', async () => {
    delete process.env.FACTS_API_ENABLED;
    try {
      const names = await toolsList();
      expect(names).not.toContain('get_fact');
      expect(names).not.toContain('get_fact_provenance');
      // Baseline read tools are untouched by the flag.
      expect(names).toContain('search_knowledge');

      // The SDK folds its unknown-tool McpError into an isError tool
      // result ("MCP error -32602: Tool get_fact not found") — the
      // absent-tool refusal, never a successful read.
      const out = await toolCall('get_fact', { factId });
      expect(out.result.isError).toBe(true);
      expect(String(out.result.content?.[0]?.text ?? '')).toContain('not found');

      // REST twin at the same instant: 404 behind the same flag.
      const rest = await f.http
        .get(`/v1/facts/${encodeURIComponent(factId)}`)
        .set({ Authorization: `Bearer ${f.apiKey}` });
      expect(rest.status).toBe(404);
    } finally {
      process.env.FACTS_API_ENABLED = '1';
    }
  });
});
