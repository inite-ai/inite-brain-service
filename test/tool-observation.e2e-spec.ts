/**
 * Tool observations e2e (migration 0111):
 *   (a) an MCP tool call under TOOL_OBSERVATIONS_ENABLED writes ONE
 *       content-free tool_observation row (digests, no payloads);
 *   (b) master flag off ⇒ zero rows (byte-identical);
 *   (c) document ingest with toolObservationRef ⇒ the committed fact's
 *       source.evidence[] carries BOTH hops (document + tool_observation),
 *       and an unknown ref answers 400;
 *   (d) the prune leg removes aged rows.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { McpService } from '../src/mcp/mcp.service';
import { ToolObservationService } from '../src/outcomes/tool-observation.service';
import { OutcomePruneService } from '../src/outcomes/outcome-prune.service';
import { StringRecordId } from 'surrealdb';

interface ObservationRow {
  id: unknown;
  tool: string;
  argsDigest: string;
  resultDigest: string;
  ok: boolean;
  contentExcerpt?: string;
}

describe('tool_observation — content-free evidence anchors (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_toolobs_e2e' });
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    delete process.env.TOOL_OBSERVATION_CONTENT;
    delete process.env.DOCUMENT_INGEST_ENABLED;
    if (f) await f.close();
  });

  const allRows = async (): Promise<ObservationRow[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[ObservationRow[]]>(
        'SELECT * FROM tool_observation ORDER BY createdAt ASC',
      );
      return (rows as ObservationRow[]) ?? [];
    });
  };

  /** The recorder is fire-and-forget — poll until the count holds. */
  const waitForCount = async (n: number): Promise<ObservationRow[]> => {
    let rows = await allRows();
    for (let i = 0; i < 40 && rows.length < n; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await allRows();
    }
    return rows;
  };

  /** Invoke a registered MCP tool through the patched wrapper chain. */
  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const server = await f.app
      .get(McpService)
      .buildServer(f.companyId, ['brain:read', 'brain:write']);
    const internals = server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler?: (a: unknown, extra: unknown) => unknown;
          callback?: (a: unknown, extra: unknown) => unknown;
        }
      >;
    };
    const tool = internals._registeredTools[name]!;
    return (tool.handler ?? tool.callback)!(args, {});
  };

  it('an MCP tool call under the flag writes ONE content-free row', async () => {
    await callTool('list_procedures', {});
    const rows = await waitForCount(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tool).toBe('list_procedures');
    expect(row.ok).toBe(true);
    expect(row.argsDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(row.resultDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(row.contentExcerpt).toBeFalsy();
  });

  it('master flag off ⇒ an MCP tool call writes ZERO rows', async () => {
    const before = (await allRows()).length;
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    await callTool('list_procedures', {});
    await new Promise((r) => setTimeout(r, 300));
    expect((await allRows()).length).toBe(before);
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
  });

  it('ingest with toolObservationRef ⇒ fact evidence carries both hops', async () => {
    // Seed the observation the document claims to derive from.
    f.app.get(ToolObservationService).record(f.companyId, {
      tool: 'web_fetch',
      args: { url: 'https://example.com/report' },
      result: { status: 200 },
      ok: true,
      durationMs: 12,
    });
    const rows = await waitForCount((await allRows()).length + 1);
    const obs = rows[rows.length - 1]!;
    const ref = String(obs.id);
    expect(ref).toMatch(/^tool_observation:/);

    f.extractor.setScript({
      entities: [{ name: 'Acme Corp', type: 'customer' }],
      facts: [{ entityIndex: 0, predicate: 'tier', object: 'platinum', confidence: 0.9 }],
      edges: [],
    });
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text: 'Fetched report: Acme is platinum tier.',
        occurredAt: '2026-08-01T10:00:00.000Z',
        contextRef: { vertical: 'toolobs_e2e' },
        toolObservationRef: ref,
      });
    expect(r.status).toBe(201);
    const factId = r.body.committed.factIds[0] as string;
    expect(factId).toBeDefined();

    const surreal = f.app.get(SurrealService);
    const evidence = await surreal.withCompany(f.companyId, async (db) => {
      const [res] = await db.query<
        [Array<{ source: { evidence: Array<Record<string, string>> } }>]
      >('SELECT source FROM $id', { id: new StringRecordId(factId) });
      return (res as Array<{ source: { evidence: Array<Record<string, string>> } }>)[0]!.source
        .evidence;
    });
    const kinds = evidence.map((e) => e.kind);
    expect(kinds).toContain('document');
    expect(kinds).toContain('tool_observation');
    const hop = evidence.find((e) => e.kind === 'tool_observation')!;
    expect(hop.ref).toBe(ref);
    expect(hop.note).toMatch(/^web_fetch @ \d{4}-\d{2}-\d{2}T/);
  });

  it('an unknown toolObservationRef answers 400', async () => {
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text: 'Unverifiable provenance claim.',
        occurredAt: '2026-08-01T11:00:00.000Z',
        contextRef: { vertical: 'toolobs_e2e' },
        toolObservationRef: 'tool_observation:does_not_exist',
      });
    expect(r.status).toBe(400);
  });

  it('the prune leg removes aged rows and keeps fresh ones', async () => {
    const surreal = f.app.get(SurrealService);
    // Backdate every existing row far past the retention window, then
    // add one fresh row.
    await surreal.withCompany(f.companyId, async (db) => {
      await db.query(`UPDATE tool_observation SET createdAt = <datetime> '2020-01-01T00:00:00Z'`);
    });
    f.app.get(ToolObservationService).record(f.companyId, {
      tool: 'fresh_tool',
      ok: true,
      durationMs: 1,
    });
    let rows = await allRows();
    for (let i = 0; i < 40 && !rows.some((x) => x.tool === 'fresh_tool'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await allRows();
    }
    const pruned = await f.app.get(OutcomePruneService).pruneToolObservations(f.companyId);
    expect(pruned).toBeGreaterThan(0);
    rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe('fresh_tool');
  });
});
