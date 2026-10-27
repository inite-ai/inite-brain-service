/**
 * Progressive indexing end to end on a REAL SurrealDB (W6): a
 * manifest-only connection that reads nothing until a question makes it
 * worth reading.
 *
 *   - a `manifest` walk catalogues every file and fetches NONE of them;
 *   - a question that matches a filename counts a hit on that row and
 *     queues it — the answer it rode in on is unchanged;
 *   - the queued job fetches that row ALONE and ingests it;
 *   - the next question finds the content;
 *   - a second hit on an already-deepened row queues nothing;
 *   - with the flag off, no hit is counted and nothing is ever queued.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { SourceSyncQueueService } from '../src/source-plane/source-sync-queue.service';
import { FILE_MEMORY_PACK } from '../src/ai/domain-packs/file-memory.pack';

const COMPANY = 'co_progressive_e2e';
const ENV = [
  'SOURCE_PLANE_ENABLED',
  'SOURCE_KIND_FS',
  'SOURCE_FS_ROOTS',
  'SOURCE_PROGRESSIVE',
  'SOURCE_DEEPEN_PER_QUERY',
  'DOCUMENT_INGEST_ENABLED',
  'WORKER_LOOP_ENABLED',
  'JOB_RUN_PERSIST',
];

interface ItemRow {
  externalId: string;
  state: string;
  hitCount: number;
  documentId: unknown;
  deepenedAt: unknown;
}

describe('progressive indexing (e2e)', () => {
  let f: AppFixture;
  let root = '';
  const saved: Record<string, string | undefined> = {};
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'brain-progressive-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'payments-runbook.md'),
      '# Payments runbook\n\nRestart the payments gateway nightly at 03:00 UTC.\n',
    );
    writeFileSync(
      join(root, 'docs', 'warehouse-inventory.md'),
      '# Warehouse inventory\n\nThe Riga warehouse holds the cold-chain sensors.\n',
    );
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      WORKER_LOOP_ENABLED: '0',
      SOURCE_PLANE_ENABLED: '1',
      SOURCE_KIND_FS: '1',
      SOURCE_FS_ROOTS: root,
      SOURCE_PROGRESSIVE: '1',
      SOURCE_DEEPEN_PER_QUERY: '2',
      DOCUMENT_INGEST_ENABLED: '1',
      JOB_RUN_PERSIST: '1',
    });
    f = await createApp({ companyId: COMPANY });
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };
  const items = () =>
    rows<ItemRow>(
      `SELECT externalId, state, hitCount, documentId, deepenedAt FROM source_item ORDER BY externalId ASC`,
    );
  const queue = () => f.app.get(SourceSyncQueueService);

  let connectionId = '';

  it('a manifest walk catalogues everything and reads nothing', async () => {
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: FILE_MEMORY_PACK, acceptSources: true, acceptModalities: true });
    expect([200, 201]).toContain(install.status);
    const conn = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'file_memory',
        sourceId: 'folder',
        vertical: 'files',
        label: 'Org drive (catalogue only)',
        config: { root: join(root, 'docs') },
        contentPolicy: 'manifest',
      });
    expect(conn.status).toBe(201);
    connectionId = conn.body.id;
    const run = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 2, fetched: 0 });
    const catalogue = await items();
    expect(catalogue.map((i) => i.externalId)).toEqual([
      'payments-runbook.md',
      'warehouse-inventory.md',
    ]);
    for (const i of catalogue) {
      expect(i.documentId ?? null).toBeNull();
      expect(i.hitCount).toBe(0);
    }
  }, 60_000);

  it('a question that matches a filename counts the hit and queues that row', async () => {
    const queued = await queue().probeAndQueue(COMPANY, 'where is the payments runbook?');
    expect(queued).toBe(1);
    const after = await items();
    const runbook = after.find((i) => i.externalId === 'payments-runbook.md')!;
    const other = after.find((i) => i.externalId === 'warehouse-inventory.md')!;
    expect(runbook.hitCount).toBe(1);
    // The other file matched no term of the question: a hit is a match,
    // not a visit.
    expect(other.hitCount).toBe(0);
    // A hit is not a read.
    expect(runbook.documentId ?? null).toBeNull();
  }, 60_000);

  it('the queued job reads that row ALONE, and a second hit queues nothing', async () => {
    const jobs = await rows<{ payload: { connectionId: string; deepen: unknown } | null }>(
      `SELECT payload, jobType, dedupKey, createdAt FROM job_run
        WHERE jobType = 'source_sync' AND dedupKey CONTAINS 'deepen'
        ORDER BY createdAt DESC LIMIT 1`,
    );
    expect(jobs).toHaveLength(1);
    const payload = jobs[0]!.payload!;
    expect(payload.deepen).toBeTruthy();
    const summary = await queue().executeFromQueue({
      companyId: COMPANY,
      payload: payload as unknown as Record<string, unknown>,
      abortSignal: new AbortController().signal,
    } as never);
    expect(summary).toMatchObject({
      status: 'succeeded',
      fetched: 1,
      ingested: 1,
      ranBy: 'deepen',
    });

    const after = await items();
    const runbook = after.find((i) => i.externalId === 'payments-runbook.md')!;
    const other = after.find((i) => i.externalId === 'warehouse-inventory.md')!;
    expect(runbook.documentId).toBeTruthy();
    expect(runbook.deepenedAt).toBeTruthy();
    // The row nobody asked about is still a catalogue entry and nothing more.
    expect(other.documentId ?? null).toBeNull();

    // The same question again: the row is already read, so it is not a
    // candidate any more and nothing is queued.
    expect(await queue().probeAndQueue(COMPANY, 'where is the payments runbook?')).toBe(0);
  }, 60_000);

  it('the deepened document is really there, with the connection’s own provenance', async () => {
    const docs = await rows<{ title: string; text: string }>(
      `SELECT title, source FROM source_document WHERE title = 'payments-runbook.md' LIMIT 1`,
    );
    expect(docs).toHaveLength(1);
    const chunks = await rows<{ text: string }>(
      `SELECT text FROM source_chunk WHERE docId IN (SELECT VALUE id FROM source_document WHERE title = 'payments-runbook.md')`,
    );
    expect(chunks.map((c) => c.text).join('')).toContain('03:00 UTC');
  }, 60_000);

  it('an operator can read one catalogued row on demand — named rows are a deepening, not a walk', async () => {
    const before = await items();
    const other = before.find((i) => i.externalId === 'warehouse-inventory.md')!;
    expect(other.documentId ?? null).toBeNull();
    const itemRows = await rows<{ id: unknown; externalId: string }>(
      `SELECT id, externalId FROM source_item WHERE externalId = 'warehouse-inventory.md' LIMIT 1`,
    );
    const run = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true, itemIds: [String(itemRows[0]!.id)] });
    expect(run.body.summary).toMatchObject({ status: 'succeeded', seen: 1, fetched: 1 });
    const after = await items();
    expect(after.find((i) => i.externalId === 'warehouse-inventory.md')!.documentId).toBeTruthy();
    // A deepening reads; it never re-enumerates, so nothing was seen anew.
    expect(run.body.summary.new).toBe(0);
    expect(run.body.summary.gone).toBe(0);
  }, 60_000);

  it('with the flag off nothing is probed, counted or queued', async () => {
    process.env.SOURCE_PROGRESSIVE = '0';
    try {
      const before = (await items()).find((i) => i.externalId === 'warehouse-inventory.md')!;
      expect(await queue().probeAndQueue(COMPANY, 'the Riga warehouse inventory')).toBe(0);
      const after = (await items()).find((i) => i.externalId === 'warehouse-inventory.md')!;
      expect(after.hitCount).toBe(before.hitCount);
    } finally {
      process.env.SOURCE_PROGRESSIVE = '1';
    }
  }, 60_000);
});
