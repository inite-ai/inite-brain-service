/**
 * The agent's `db` source end to end on a REAL SurrealDB (W4.4): a
 * SQLite database on the agent's machine, a `crm_memory/db` connection
 * on `agent:<id>` naming the database by label — the brain refuses a
 * config carrying a DSN and a server host — the agent walks tables and
 * a view into record envelopes, the brain's records door turns them
 * into facts by the connection's mapping (relations included); the
 * second run is incremental by the change column and re-reads only
 * what changed; the agent's check-in names its databases; the
 * catalogue shows the source as agent-only with the mapping vocabulary.
 */
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CRM_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';
import { DbAgentConnector } from '../clients/brain-agent/src/connectors/db';
import { inventory } from '../clients/brain-agent/src/inventory';
import { BrainAgentClient } from '../clients/brain-agent/src/protocol';
import { connectorFor, runConnection } from '../clients/brain-agent/src/runner';

const COMPANY = 'co_agent_db_e2e';
const AGENT = 'laptop-db';

describe('brain-agent db source (e2e)', () => {
  let f: AppFixture;
  let baseUrl = '';
  let dir = '';
  let file = '';
  let connectionId = '';
  const saved: Record<string, string | undefined> = {};
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    for (const k of ['SOURCE_PLANE_ENABLED', 'DOCUMENT_INGEST_ENABLED', 'WORKER_LOOP_ENABLED'])
      saved[k] = process.env[k];
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.SOURCE_PLANE_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    f = await createApp({ companyId: COMPANY });
    const server = f.app.getHttpServer() as import('node:http').Server;
    if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    dir = await mkdtemp(join(tmpdir(), 'brain-agent-db-e2e-'));
    file = join(dir, 'crm.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, industry TEXT, website TEXT, api_key TEXT);
      CREATE VIEW companies_v AS SELECT id, name, industry, website FROM companies;
      CREATE TABLE deals (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, amount REAL, currency TEXT, stage TEXT,
        company_id INTEGER, updated_at TEXT NOT NULL
      );
      INSERT INTO companies VALUES (5, 'Nimbus Foods', 'Food', 'nimbus.test', 'sk-secret');
      INSERT INTO companies VALUES (6, 'Acme Robotics', 'Robotics', 'acme.test', 'sk-secret-2');
      INSERT INTO deals VALUES (100, 'Nimbus — Q4 supply', 48000, 'EUR', 'Negotiation', 5, '2026-09-01T10:00:00Z');
      INSERT INTO deals VALUES (101, 'Acme — robots', 125000, 'EUR', 'Proposal', 6, '2026-09-03T12:30:00Z');
    `);
    db.close();

    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: CRM_MEMORY_PACK, acceptSources: true });
    expect([200, 201]).toContain(install.status);
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    if (f) await f.close();
  });

  const agent = () => new BrainAgentClient({ baseUrl, apiKey: f.apiKey });
  const connector = () =>
    new DbAgentConnector((name) => (name === 'crm' ? `sqlite:${file}` : null));
  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const factsOf = async (predicate: string): Promise<string[]> => {
    const facts = await rows<{ object: string }>(
      `SELECT object FROM knowledge_fact WHERE predicate = $p AND validUntil = NONE`,
      { p: predicate },
    );
    return facts.map((x) => x.object).sort();
  };
  const CONFIG = {
    database: 'crm',
    entities: [
      {
        type: 'deal',
        table: 'deals',
        nameColumn: 'title',
        updatedAtColumn: 'updated_at',
        relations: [{ kind: 'organization', column: 'company_id', targetType: 'organization' }],
      },
      { type: 'organization', table: 'companies_v', columns: ['industry', 'website'] },
    ],
    mapping: {
      deal: { fields: { stage: 'deal_stage', amount: 'deal_amount', currency: 'currency' } },
      organization: { fields: { industry: 'industry', website: 'website' } },
    },
  };

  it('the catalogue lists the db source as agent-only with the mapping vocabulary; the brain refuses a DSN in the config and a server host', async () => {
    const cat = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    const entry = cat.body.sources.find((e: { sourceId: string }) => e.sourceId === 'db');
    expect(entry).toMatchObject({
      connector: 'db',
      availability: 'agent',
      hosts: ['agent'],
      shape: 'structure',
    });
    expect(entry.records.entities).toEqual([]);
    expect(entry.records.predicates.map((p: { localId: string }) => p.localId)).toContain(
      'deal_stage',
    );

    const create = (body: Record<string, unknown>) =>
      f.http
        .post('/v1/admin/source-connections')
        .set(auth())
        .send({
          packId: 'crm_memory',
          sourceId: 'db',
          vertical: 'crm',
          ...body,
        });
    const onServer = await create({ config: CONFIG });
    expect(onServer.status).toBe(400);
    expect(onServer.body.message).toMatch(/runs on a local agent/);
    const withDsn = await create({
      host: `agent:${AGENT}`,
      config: { ...CONFIG, dsn: `sqlite:${file}` },
    });
    expect(withDsn.status).toBe(400);
    expect(withDsn.body.message).toMatch(/must not carry dsn — the DSN stays on the agent/);
    const badIdent = await create({
      host: `agent:${AGENT}`,
      config: { ...CONFIG, entities: [{ type: 'deal', table: 'deals; drop table deals' }] },
    });
    expect(badIdent.status).toBe(400);
    expect(badIdent.body.message).toMatch(/config\.entities\.0\.table/);
    const ok = await create({ host: `agent:${AGENT}`, label: 'Acme CRM (db)', config: CONFIG });
    expect(ok.status).toBe(201);
    connectionId = ok.body.id;
    expect(JSON.stringify(ok.body)).not.toContain('sqlite:');
  });

  it('the agent checks in naming its databases; the first run walks the tables and the view into facts and relations', async () => {
    await agent().checkIn(AGENT, await inventory([dir], '0.1.0', ['crm']));
    const agents = await f.http.get('/v1/admin/source-connections/agents').set(auth());
    expect(agents.body.agents.find((a: { agentId: string }) => a.agentId === AGENT)).toMatchObject({
      databases: ['crm'],
    });

    const targets = await agent().listConnections(AGENT);
    const target = targets.find((t) => t.connection.id === connectionId)!;
    expect(target.source).toMatchObject({ id: 'db', connector: 'db' });
    const c = connectorFor([connector()], target);
    const summary = await runConnection(agent(), c, target, { agentId: AGENT });
    expect(summary).toMatchObject({
      status: 'succeeded',
      seen: 4,
      new: 4,
      fetched: 4,
      ingested: 4,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Negotiation', 'Proposal']);
    expect(await factsOf('crm_memory__deal_amount')).toEqual(['125000', '48000']);
    expect(await factsOf('crm_memory__industry')).toEqual(['Food', 'Robotics']);
    expect(await factsOf('crm_memory__website')).toEqual(['acme.test', 'nimbus.test']);
    const edges = await rows<{ kind: string }>(`SELECT kind FROM knowledge_edge`);
    expect(edges.map((e) => e.kind)).toContain('organization');
    // The view hid the api_key column and nothing of it reached the brain.
    const docs = await rows<{ text: string }>(`SELECT text FROM source_chunk`);
    expect(docs.map((d) => d.text).join('\n')).not.toContain('sk-secret');
    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items`)
      .set(auth());
    expect(items.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual([
      'deal/100',
      'deal/101',
      'organization/5',
      'organization/6',
    ]);
    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body.checkpoint).toEqual({ since: { deal: '2026-09-03T12:30:00Z' } });
  });

  it('the second run is incremental by the change column: a changed deal and a new one are fetched, the view is re-hashed and unchanged', async () => {
    const db = new DatabaseSync(file);
    db.exec(`
      UPDATE deals SET stage = 'Contract', updated_at = '2026-09-10T08:00:00Z' WHERE id = 100;
      INSERT INTO deals VALUES (102, 'Nimbus — renewal', 9000, 'EUR', 'Lead', 5, '2026-09-11T09:00:00Z');
    `);
    db.close();
    const target = (await agent().listConnections(AGENT)).find(
      (t) => t.connection.id === connectionId,
    )!;
    const summary = await runConnection(agent(), connector(), target, { agentId: AGENT });
    expect(summary).toMatchObject({
      status: 'succeeded',
      mode: 'incremental',
      seen: 4,
      new: 1,
      changed: 1,
      unchanged: 2,
      fetched: 2,
      ingested: 2,
      failed: 0,
    });
    expect(await factsOf('crm_memory__deal_stage')).toEqual(['Contract', 'Lead', 'Proposal']);
    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body.checkpoint).toEqual({ since: { deal: '2026-09-11T09:00:00Z' } });
  });
});
