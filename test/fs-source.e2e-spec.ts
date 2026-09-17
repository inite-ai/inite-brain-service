/**
 * The `fs` connector end to end (W1) against a REAL SurrealDB: install the
 * first-party file_memory pack (sources + media consent), connect a temp
 * folder under the SOURCE_FS_ROOTS jail, sync inline — every text file
 * becomes a document (kind `file`, `file://` originUri, revision stamp
 * system `fs`) with facts; edit a file → exactly that one re-syncs; delete
 * a file → the walk (walksEverything ⇒ full) marks it gone and `close`
 * stamps validUntil on its facts; the kind switch off ⇒ a connection
 * cannot be created and an existing one records a named failed sync.
 */
import { mkdtemp, mkdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { FILE_MEMORY_PACK } from '../src/ai/domain-packs';
import { SurrealService } from '../src/db/surreal.service';

const COMPANY = 'co_fs_source_e2e';

describe('fs source connector (e2e)', () => {
  let f: AppFixture;
  let base = '';
  let root = '';
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'fs-source-e2e-'));
    root = join(base, 'vault');
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Vault\nThe vault documents the payments gateway.');
    await writeFile(join(root, 'docs', 'oncall.md'), 'On-call rotation: see docs/alerts.md.');
    await writeFile(join(root, 'docs', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    for (const k of [
      'SOURCE_PLANE_ENABLED',
      'SOURCE_KIND_FS',
      'SOURCE_FS_ROOTS',
      'DOCUMENT_INGEST_ENABLED',
      'WORKER_LOOP_ENABLED',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.SOURCE_PLANE_ENABLED = '1';
    process.env.SOURCE_KIND_FS = '1';
    process.env.SOURCE_FS_ROOTS = base;
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    f = await createApp({ companyId: COMPANY });
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(base, { recursive: true, force: true });
    if (f) await f.close();
  });

  const rows = async <T>(sql: string, vars: Record<string, unknown> = {}): Promise<T[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(COMPANY, async (db) => {
      const [out] = await db.query<[T[]]>(sql, vars);
      return (out as T[]) ?? [];
    });
  };

  let connectionId = '';

  it('installs file_memory with sources + media consent and connects a folder inside the jail', async () => {
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: FILE_MEMORY_PACK, acceptSources: true, acceptModalities: true });
    expect([200, 201]).toContain(install.status);

    const outside = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({
        packId: 'file_memory',
        sourceId: 'folder',
        vertical: 'files',
        config: { root: '/etc' },
      });
    // Creation succeeds (the jail is checked at sync time, where the root
    // is resolved); the sync then fails by name.
    expect(outside.status).toBe(201);
    const jailed = await f.http
      .post(`/v1/admin/source-connections/${outside.body.id}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(jailed.body.summary).toMatchObject({ status: 'failed' });
    expect(jailed.body.summary.error).toContain('outside SOURCE_FS_ROOTS');
    await f.http.delete(`/v1/admin/source-connections/${outside.body.id}`).set(auth());

    const r = await f.http.post('/v1/admin/source-connections').set(auth()).send({
      packId: 'file_memory',
      sourceId: 'folder',
      vertical: 'files',
      label: 'Vault',
      config: { root },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      connector: 'fs',
      shape: 'document',
      contentPolicy: 'text',
      deletePolicy: 'close',
    });
    connectionId = r.body.id;
  });

  it('sync: every text file becomes a document with a file:// origin and an fs revision stamp', async () => {
    const r = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(r.body.summary).toMatchObject({
      mode: 'full',
      status: 'succeeded',
      seen: 2,
      new: 2,
      fetched: 2,
      ingested: 2,
      failed: 0,
    });

    const docs = await rows<{
      kind: string;
      originUri: string;
      title: string;
      meta: Record<string, unknown>;
    }>(`SELECT kind, originUri, title, meta FROM source_document WHERE kind = 'file'`);
    expect(docs).toHaveLength(2);
    const readme = docs.find((d) => d.title === 'README.md')!;
    expect(readme.originUri).toMatch(/^file:\/\/.*\/vault\/README\.md$/);
    expect(readme.meta).toMatchObject({
      source_pack: 'file_memory',
      source_id: 'folder',
      sourceVersionSystem: 'fs',
      sourceVersionRef: 'README.md',
    });
    expect(String(readme.meta.sourceVersionValue)).toMatch(/^\d+:\d+$/);

    const facts = await rows<{ source: Record<string, unknown> }>(
      `SELECT source FROM knowledge_fact WHERE source.meta.source_pack = 'file_memory'`,
    );
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts[0]!.source.sourceVersion).toMatchObject({ system: 'fs' });

    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items`)
      .set(auth());
    expect(items.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual([
      'README.md',
      'docs/oncall.md',
    ]);
  });

  it('an edited file re-syncs alone; a deleted file goes gone and its facts close', async () => {
    await writeFile(
      join(root, 'docs', 'oncall.md'),
      'On-call rotation changed: see docs/alerts-v2.md.',
    );
    await utimes(join(root, 'docs', 'oncall.md'), new Date(), new Date(Date.now() + 5000));
    const edited = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(edited.body.summary).toMatchObject({
      mode: 'full',
      seen: 2,
      changed: 1,
      unchanged: 1,
      fetched: 1,
      ingested: 1,
      gone: 0,
    });

    await unlink(join(root, 'README.md'));
    const removed = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(removed.body.summary).toMatchObject({ seen: 1, unchanged: 1, gone: 1, fetched: 0 });
    expect(removed.body.summary.closed).toBeGreaterThanOrEqual(1);
    const gone = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items?state=gone`)
      .set(auth());
    expect(gone.body.items.map((i: { externalId: string }) => i.externalId)).toEqual(['README.md']);
    const closed = await rows<{ validUntil: unknown }>(
      `SELECT validUntil FROM knowledge_fact WHERE source.documentId = $docId`,
      { docId: gone.body.items[0].documentId },
    );
    expect(closed.length).toBeGreaterThanOrEqual(1);
    for (const fact of closed) expect(fact.validUntil).not.toBeNull();
  });

  it('the kind switch off: no new connection, and an existing one records a named failed sync', async () => {
    delete process.env.SOURCE_KIND_FS;
    const refused = await f.http.post('/v1/admin/source-connections').set(auth()).send({
      packId: 'file_memory',
      sourceId: 'folder_media',
      vertical: 'files',
      config: { root },
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toContain('SOURCE_KIND_FS');
    const off = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(off.body.summary).toMatchObject({ status: 'failed' });
    expect(off.body.summary.error).toContain('switched off');
    process.env.SOURCE_KIND_FS = '1';
  });
});
