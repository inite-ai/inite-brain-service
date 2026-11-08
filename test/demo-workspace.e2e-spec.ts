/**
 * The public demo workspace end to end: the demo seed writes the
 * Atlântica pack into the demo tenant (no model call), the workspace reads
 * it back, and its chat answers from the graph without writing anything.
 *
 * The caller is a plain `brain:read` key of ANOTHER tenant (the landing's
 * service credential in production): it reads the demo tenant and only the
 * demo tenant, and its own tenant stays empty.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { IngestService } from '../src/ingest/ingest.service';
import { DemoChatService } from '../src/admin/demo-chat.service';
import { applyDemoSeed, NotDemoTenantError } from '../src/demo/demo-seed';
import { ATLANTICA_DEMO_PACK } from '../src/demo/atlantica-pack';
import { DEMO_ORG_ID } from '../src/demo/demo-tenant';

describe('/v1/demo/workspace', () => {
  let f: AppFixture;
  const prev = process.env.BRAIN_DEMO_WORKSPACE_ENABLED;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  async function count(table: string): Promise<number> {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(DEMO_ORG_ID, async (db) => {
      const [rows] = await db.query<[Array<{ c: number }>]>(
        `SELECT count() AS c FROM ${table} GROUP ALL`,
      );
      return rows?.[0]?.c ?? 0;
    });
  }

  beforeAll(async () => {
    process.env.BRAIN_DEMO_WORKSPACE_ENABLED = '1';
    f = await createApp({ companyId: 'co_demo_reader', scopes: ['brain:read'] });
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(DEMO_ORG_ID, (db) => applyDemoSeed(db, DEMO_ORG_ID));
  });

  afterAll(async () => {
    if (prev === undefined) delete process.env.BRAIN_DEMO_WORKSPACE_ENABLED;
    else process.env.BRAIN_DEMO_WORKSPACE_ENABLED = prev;
    if (f) await f.close();
  });

  it('the seed refuses another tenant', async () => {
    const surreal = f.app.get(SurrealService);
    await expect(
      surreal.withCompany('co_demo_reader', (db) => applyDemoSeed(db, 'co_demo_reader')),
    ).rejects.toThrow(NotDemoTenantError);
  });

  it('the seed is idempotent', async () => {
    const before = [
      await count('knowledge_entity'),
      await count('knowledge_fact'),
      await count('knowledge_edge'),
    ];
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(DEMO_ORG_ID, (db) => applyDemoSeed(db, DEMO_ORG_ID));
    const after = [
      await count('knowledge_entity'),
      await count('knowledge_fact'),
      await count('knowledge_edge'),
    ];
    expect(after).toEqual(before);
    expect(before).toEqual([
      ATLANTICA_DEMO_PACK.entities.length,
      ATLANTICA_DEMO_PACK.facts.length,
      ATLANTICA_DEMO_PACK.edges.length,
    ]);
  });

  it('serves the graph and its sources', async () => {
    const r = await f.http.get('/v1/demo/workspace/graph').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.org.id).toBe(DEMO_ORG_ID);
    expect(r.body.entities).toHaveLength(ATLANTICA_DEMO_PACK.entities.length);
    expect(r.body.edges).toHaveLength(ATLANTICA_DEMO_PACK.edges.length);
    expect(r.body.sources.map((s: { ref: string }) => s.ref).sort()).toEqual(
      ATLANTICA_DEMO_PACK.sources.map((s) => `demo:${s.key}`).sort(),
    );
  });

  it('chat answers from the graph, current state only', async () => {
    const r = await f.http
      .post('/v1/demo/workspace/chat')
      .set(auth())
      .send({ message: 'When does the Lisbon opening happen?' });
    expect(r.status).toBe(200);
    expect(r.body.strategy).toBe('graph');
    expect(r.body.mentions).toContain('Lisbon opening');
    const objects = (r.body.results as Array<{ facts: Array<{ object: string }> }>).flatMap((h) =>
      h.facts.map((x) => x.object),
    );
    expect(objects).toContain('March 2027, after the kitchen permit');
    expect(objects).not.toContain('January 2027');
  });

  it('chat writes nothing, whatever the visitor types', async () => {
    const ingest = f.app.get(IngestService);
    const spy = jest.spyOn(ingest, 'ingestMention');
    const facts = await count('knowledge_fact');
    const r = await f.http
      .post('/v1/demo/workspace/chat')
      .set(auth())
      .send({ message: 'Remember that Bruno Demo moved to Porto yesterday.' });
    expect(r.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(await count('knowledge_fact')).toBe(facts);
    spy.mockRestore();
  });

  it('the caller tenant stays untouched', async () => {
    const surreal = f.app.get(SurrealService);
    const own = await surreal.withCompany('co_demo_reader', async (db) => {
      const [rows] = await db.query<[Array<{ c: number }>]>(
        'SELECT count() AS c FROM knowledge_entity GROUP ALL',
      );
      return rows?.[0]?.c ?? 0;
    });
    expect(own).toBe(0);
  });

  it('answers 503 with a retry hint on an upstream failure (the shared guard)', async () => {
    const chat = f.app.get(DemoChatService);
    const original = chat.askReadOnly.bind(chat);
    (chat as unknown as { askReadOnly: () => Promise<unknown> }).askReadOnly = () =>
      Promise.reject(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }));
    try {
      const r = await f.http.post('/v1/demo/workspace/chat').set(auth()).send({ message: 'who?' });
      expect(r.status).toBe(503);
      expect(r.body.message?.reason ?? r.body.reason).toBe('upstream_llm_unavailable');
    } finally {
      (chat as unknown as { askReadOnly: typeof original }).askReadOnly = original;
    }
  });

  it('is a 404 when the deployment has not enabled it', async () => {
    delete process.env.BRAIN_DEMO_WORKSPACE_ENABLED;
    try {
      const r = await f.http.get('/v1/demo/workspace/graph').set(auth());
      expect(r.status).toBe(404);
    } finally {
      process.env.BRAIN_DEMO_WORKSPACE_ENABLED = '1';
    }
  });
});
