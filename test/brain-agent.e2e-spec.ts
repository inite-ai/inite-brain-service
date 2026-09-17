/**
 * The local agent against a REAL brain (Nest on a port, real SurrealDB):
 * an operator points a folder connection at `agent:laptop-1`, the agent
 * runner walks a temp directory with its own fs connector and speaks the
 * protocol over HTTP — first run catalogues and ingests everything with
 * `file://` provenance and mtime:size stamps; an edit + a delete on disk
 * make the second run fetch one and close one; a secret in a file never
 * reaches the brain.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { FsAgentConnector } from '../clients/brain-agent/src/connectors/fs';
import { BrainAgentClient } from '../clients/brain-agent/src/protocol';
import { connectorFor, runConnection } from '../clients/brain-agent/src/runner';

const COMPANY = 'co_brain_agent_e2e';
const AGENT = 'laptop-1';

describe('brain-agent (e2e)', () => {
  let f: AppFixture;
  let baseUrl = '';
  let root = '';
  let connectionId = '';
  const saved: Record<string, string | undefined> = {};
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    for (const k of [
      'SOURCE_PLANE_ENABLED',
      'DOCUMENT_INGEST_ENABLED',
      'WORKER_LOOP_ENABLED',
      'SOURCE_KIND_FS',
    ])
      saved[k] = process.env[k];
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.SOURCE_PLANE_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    delete process.env.SOURCE_KIND_FS;
    f = await createApp({ companyId: COMPANY });
    const server = f.app.getHttpServer() as import('node:http').Server;
    if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    root = await mkdtemp(join(tmpdir(), 'brain-agent-e2e-'));
    await writeFile(
      join(root, 'README.md'),
      '# Acme\nAcme Robotics was founded in 2019 in Tallinn.',
    );
    await writeFile(join(root, 'vendors.md'), 'Preferred vendor for motors: Nidec.');
    await writeFile(
      join(root, 'ops.md'),
      'Deploy key: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD rotates monthly.',
    );

    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({
        manifest: JSON.parse(
          readFileSync(join(__dirname, '..', 'packs', 'file-memory.pack.json'), 'utf8'),
        ),
        acceptSources: true,
        acceptModalities: true,
      });
    expect([200, 201]).toContain(install.status);
    const created = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'file_memory',
        sourceId: 'folder',
        vertical: 'files',
        label: 'Laptop notes',
        host: `agent:${AGENT}`,
        config: { root },
      });
    expect(created.status).toBe(201);
    connectionId = created.body.id;
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (root) await rm(root, { recursive: true, force: true });
    if (f) await f.close();
  });

  const agent = () => new BrainAgentClient({ baseUrl, apiKey: f.apiKey });
  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };

  it('first run: the agent walks the folder and everything lands, secrets redacted', async () => {
    const targets = await agent().listConnections(AGENT);
    expect(targets).toHaveLength(1);
    const target = targets[0]!;
    expect(target.source).toMatchObject({ id: 'folder', connector: 'fs' });
    const connector = connectorFor([new FsAgentConnector()], target);
    const summary = await runConnection(agent(), connector, target, { agentId: AGENT });
    expect(summary).toMatchObject({
      mode: 'full',
      status: 'succeeded',
      seen: 3,
      new: 3,
      fetched: 3,
      ingested: 3,
      failed: 0,
    });

    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items`)
      .set(auth());
    expect(
      items.body.items
        .map((i: { externalId: string; state: string }) => [i.externalId, i.state])
        .sort(),
    ).toEqual([
      ['README.md', 'indexed'],
      ['ops.md', 'indexed'],
      ['vendors.md', 'indexed'],
    ]);
    const docs = await rows<{ id: unknown; originUri: string }>(
      `SELECT id, originUri FROM source_document WHERE kind = 'file'`,
    );
    expect(docs.map((d) => d.originUri).sort()).toEqual([
      `file://${join(root, 'README.md')}`,
      `file://${join(root, 'ops.md')}`,
      `file://${join(root, 'vendors.md')}`,
    ]);
    const ops = docs.find((d) => d.originUri.endsWith('ops.md'))!;
    const chunks = await rows<{ text: string }>(
      `SELECT text FROM source_chunk WHERE docId = $doc`,
      { doc: ops.id },
    );
    const stored = chunks.map((c) => c.text).join('');
    expect(stored).not.toContain('ghp_');
    expect(stored).toContain('[redacted:github_token]');
    const facts = await rows<{ source: { sourceVersion?: { system: string; version: string } } }>(
      `SELECT source FROM knowledge_fact WHERE source.meta.source_connection != NONE`,
    );
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0]!.source.sourceVersion?.system).toBe('fs');
    expect(facts[0]!.source.sourceVersion?.version).toMatch(/^\d+:\d+$/);
  });

  it('second run after an edit and a delete: one fetched, one closed', async () => {
    await writeFile(
      join(root, 'README.md'),
      '# Acme\nAcme Robotics was founded in 2019 in Tallinn. The CTO is Maria Lind.',
    );
    await utimes(join(root, 'README.md'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await unlink(join(root, 'vendors.md'));
    const [target] = await agent().listConnections(AGENT);
    const summary = await runConnection(agent(), new FsAgentConnector(), target!, {
      agentId: AGENT,
    });
    expect(summary).toMatchObject({
      status: 'succeeded',
      seen: 2,
      changed: 1,
      unchanged: 1,
      gone: 1,
      fetched: 1,
      ingested: 1,
    });
    expect(summary.closed).toBeGreaterThanOrEqual(1);
    const gone = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items?state=gone`)
      .set(auth());
    expect(gone.body.items.map((i: { externalId: string }) => i.externalId)).toEqual([
      'vendors.md',
    ]);
    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body).toMatchObject({ lastSyncStatus: 'succeeded' });
    expect(conn.body.checkpoint).toMatchObject({ files: 2 });
  });
});
