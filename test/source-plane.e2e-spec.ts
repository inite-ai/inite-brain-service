/**
 * Source plane (W0) end to end against a REAL SurrealDB:
 *  - OFF byte-identity: the admin surface is a bare 404;
 *  - a pack with a `sources` section needs acceptSources at install and
 *    re-asks when the section changes;
 *  - a connection instantiates the pack's source entry (a native a
 *    registered platform connector serves), declares its recorder in
 *    source_registry, and never returns its credential;
 *  - sync-now (inline): every item is catalogued, fetched through the
 *    document door, and committed — the stub extractor's fact carries
 *    source.meta.source_connection and source.sourceVersion from the
 *    item's revision;
 *  - a second sync over an unchanged source: 0 fetched, 0 new documents;
 *  - a moved revision is re-fetched into a NEW document (content
 *    identity) with the new stamp;
 *  - a full walk after the source dropped an item marks it gone and the
 *    `close` policy stamps validUntil on the facts it grounded;
 *  - delete removes the catalogue and keeps the documents.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import {
  SOURCE_CONNECTORS,
  type Connector,
  type ConnectorCtx,
  type EnumerateOptions,
  type FetchedItem,
  type ItemDelta,
  type ItemDescriptor,
} from '../src/source-plane/connector';

const COMPANY = 'co_source_plane_e2e';

const PREDICATE = {
  localId: 'page_note',
  displayLabel: 'page note',
  description: 'TYPE subject is a topic; value is a note from the wiki',
  datatype: 'string',
  semantics: 'append_only',
  decayHalfLifeDays: null,
  piiClass: 'none',
  status: 'active',
};

const manifest = (sources: unknown[], version = '1.0.0') => ({
  id: 'wiki_pack',
  version,
  description: 'Source plane e2e pack.',
  predicates: [PREDICATE],
  sources,
});

const WIKI_SOURCE = { id: 'wiki', kind: 'native', connector: 'memory', shape: 'document' };

class MemorySource implements Connector {
  readonly kind = 'memory';
  items = new Map<string, ItemDescriptor>();
  fetches: string[] = [];
  async *enumerate(_ctx: ConnectorCtx, _opts: EnumerateOptions): AsyncIterable<ItemDelta> {
    for (const item of this.items.values()) yield { type: 'upsert', item };
    yield { type: 'checkpoint', checkpoint: { walked: this.items.size } };
  }
  async fetch(_ctx: ConnectorCtx, item: ItemDescriptor): Promise<FetchedItem> {
    this.fetches.push(item.externalId);
    return {
      shape: 'document',
      text: `Page ${item.externalId} says: ${item.title} at ${item.revision}.`,
    };
  }
}

describe('source plane (e2e)', () => {
  let f: AppFixture;
  let source: MemorySource;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of [
      'SOURCE_PLANE_ENABLED',
      'DOCUMENT_INGEST_ENABLED',
      'WORKER_LOOP_ENABLED',
      'SOURCE_KIND_FS',
      'SOURCE_FS_ROOTS',
      'SOURCE_EGRESS_ALLOW_PRIVATE',
    ]) {
      saved[k] = process.env[k];
    }
    // The handler registers at boot; keep the worker loop out so the
    // inline sync is the only actor.
    process.env.WORKER_LOOP_ENABLED = '0';
    delete process.env.SOURCE_PLANE_ENABLED;
    // The catalogue case pins the natives' switched-off state.
    delete process.env.SOURCE_KIND_FS;
    delete process.env.SOURCE_FS_ROOTS;
    delete process.env.SOURCE_EGRESS_ALLOW_PRIVATE;
    f = await createApp({ companyId: COMPANY });
    source = new MemorySource();
    (f.app.get(SOURCE_CONNECTORS) as Connector[]).push(source);
  }, 120_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
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

  it('OFF byte-identity: the admin surface is a bare 404', async () => {
    const r = await f.http.get('/v1/admin/source-connections').set(auth());
    expect(r.status).toBe(404);
  });

  it('a pack with sources needs acceptSources; a changed section re-asks', async () => {
    process.env.SOURCE_PLANE_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    const refused = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest([WIKI_SOURCE]) });
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toContain('native "wiki" (memory, document)');

    const ok = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest([WIKI_SOURCE]), acceptSources: true });
    expect([200, 201]).toContain(ok.status);

    // Same section on an upgrade: prior consent carries over.
    const same = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest([WIKI_SOURCE], '1.0.1') });
    expect([200, 201]).toContain(same.status);

    // A changed section re-requires the flag; then accepted.
    const changed = [
      WIKI_SOURCE,
      { id: 'files', kind: 'native', connector: 'memory', shape: 'binary' },
    ];
    const reask = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest(changed, '1.1.0') });
    expect(reask.status).toBe(400);
    const accepted = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: manifest(changed, '1.1.0'), acceptSources: true });
    expect([200, 201]).toContain(accepted.status);
  });

  it('the catalogue lists what can be connected here, with consent and connector state', async () => {
    const r = await f.http.get('/v1/admin/source-connections/catalog').set(auth());
    expect(r.status).toBe(200);
    const byId = new Map<string, Record<string, unknown>>(
      (r.body.sources as Array<Record<string, unknown>>).map((e) => [
        `${e.packId}/${e.sourceId}`,
        e,
      ]),
    );
    // The installed pack's two entries, consented, on the test connector
    // (pushed into the registry, no switch ⇒ ready).
    const wiki = byId.get('wiki_pack/wiki');
    expect(wiki).toMatchObject({
      builtin: false,
      accepted: true,
      kind: 'native',
      connector: 'memory',
      shape: 'document',
      availability: 'ready',
      configExample: null,
      defaults: { contentPolicy: 'text', deletePolicy: 'close', schedule: 'manual' },
    });
    expect(byId.get('wiki_pack/files')?.availability).toBe('ready');
    // The builtin code_memory repository entry: external ⇒ the publisher pushes.
    expect(byId.get('code_memory/repository')).toMatchObject({
      builtin: true,
      accepted: true,
      availability: 'external',
    });
    // Shipped natives are present and switched off in this run.
    const connectors = new Map<string, Record<string, unknown>>(
      (r.body.connectors as Array<Record<string, unknown>>).map((c) => [String(c.kind), c]),
    );
    expect(connectors.get('fs')).toEqual({ kind: 'fs', state: 'disabled', flag: 'SOURCE_KIND_FS' });
    expect(connectors.get('memory')?.state).toBe('ready');
    expect(r.body.fsRoots).toEqual([]);
    expect(r.body.egressAllowPrivate).toBe(false);
  });

  let connectionId = '';

  it('creates a connection for the source entry — recorder declared, credential never returned', async () => {
    const unknownSource = await f.http
      .post('/v1/admin/source-connections')
      .set(auth())
      .send({ packId: 'wiki_pack', sourceId: 'nope', vertical: 'wiki' });
    expect(unknownSource.status).toBe(404);

    const r = await f.http.post('/v1/admin/source-connections').set(auth()).send({
      packId: 'wiki_pack',
      sourceId: 'wiki',
      vertical: 'wiki',
      label: 'Team wiki',
      credential: 'super-secret',
      schedule: '1h',
    });
    expect(r.status).toBe(201);
    connectionId = r.body.id;
    expect(r.body).toMatchObject({
      packId: 'wiki_pack',
      sourceId: 'wiki',
      kind: 'native',
      connector: 'memory',
      shape: 'document',
      host: 'server',
      label: 'Team wiki',
      hasCredential: true,
      mode: 'synced',
      schedule: '1h',
      contentPolicy: 'text',
      deletePolicy: 'close',
      status: 'active',
      vertical: 'wiki',
      checkpoint: null,
      lastSyncAt: null,
    });
    expect(JSON.stringify(r.body)).not.toContain('super-secret');
    expect(r.body.recorder).toMatch(/^srcconn_/);
    expect(r.body.sourceKey).toBe(`wiki:${r.body.recorder}`);

    const registry = await f.http.get(`/v1/admin/sources/${r.body.sourceKey}`).set(auth());
    expect(registry.status).toBe(200);
    expect(registry.body.declared).toMatchObject({ type: 'document', owner: 'pack:wiki_pack' });

    const list = await f.http.get('/v1/admin/source-connections').set(auth());
    expect(list.body.connections.map((c: { id: string }) => c.id)).toEqual([connectionId]);
  });

  it('sync-now (inline): catalogues, fetches through the document door, commits facts with the stamp', async () => {
    source.items.set('onboarding', {
      externalId: 'onboarding',
      title: 'Onboarding',
      revision: 'r1',
      originUri: 'https://wiki.example/onboarding',
    });
    source.items.set('oncall', { externalId: 'oncall', title: 'On-call', revision: 'r1' });
    const r = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(r.status).toBe(201);
    expect(r.body.enqueued).toBe(false);
    expect(r.body.summary).toMatchObject({
      mode: 'full',
      status: 'succeeded',
      seen: 2,
      new: 2,
      fetched: 2,
      ingested: 2,
      deduplicated: 0,
      failed: 0,
      gone: 0,
    });
    expect(source.fetches.sort()).toEqual(['onboarding', 'oncall']);

    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items`)
      .set(auth());
    expect(items.body.total).toBe(2);
    for (const item of items.body.items) {
      expect(item).toMatchObject({ state: 'indexed', revision: 'r1', fetchedRevision: 'r1' });
      expect(item.documentId).toMatch(/^source_document:/);
    }

    const docs = await rows<{ kind: string; originUri: string; meta: Record<string, unknown> }>(
      `SELECT kind, originUri, meta FROM source_document WHERE kind = 'source_document'`,
    );
    expect(docs).toHaveLength(2);
    const onboarding = docs.find((d) => d.originUri === 'https://wiki.example/onboarding')!;
    expect(onboarding.meta).toMatchObject({
      source_connection: connectionId.slice(connectionId.indexOf(':') + 1),
      source_pack: 'wiki_pack',
      sourceConnectionId: connectionId,
      sourceVersionSystem: 'memory',
      sourceVersionRef: 'onboarding',
      sourceVersionValue: 'r1',
    });
    const other = docs.find((d) => d.originUri !== 'https://wiki.example/onboarding')!;
    expect(other.originUri).toMatch(/^source:\/\/[A-Za-z0-9_]+\/oncall$/);

    const facts = await rows<{ source: Record<string, unknown> }>(
      `SELECT source FROM knowledge_fact WHERE source.meta.source_connection != NONE`,
    );
    expect(facts.length).toBeGreaterThanOrEqual(2);
    expect(facts[0]!.source.meta).toMatchObject({
      source_connection: expect.any(String),
      source_pack: 'wiki_pack',
    });
    expect(facts[0]!.source.sourceVersion).toMatchObject({ system: 'memory', version: 'r1' });

    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body).toMatchObject({ lastSyncStatus: 'succeeded', checkpoint: { walked: 2 } });
    expect(conn.body.lastSyncAt).not.toBeNull();
  });

  it('a second sync over an unchanged source fetches nothing; a moved revision is re-fetched', async () => {
    source.fetches = [];
    const again = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(again.body.summary).toMatchObject({
      mode: 'incremental',
      seen: 2,
      unchanged: 2,
      fetched: 0,
      ingested: 0,
    });
    expect(source.fetches).toEqual([]);

    source.items.set('oncall', {
      externalId: 'oncall',
      title: 'On-call (rotation changed)',
      revision: 'r2',
    });
    const moved = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(moved.body.summary).toMatchObject({ changed: 1, unchanged: 1, fetched: 1, ingested: 1 });
    expect(source.fetches).toEqual(['oncall']);
    const stamps = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM source_document WHERE meta.sourceVersionRef = 'oncall'`,
    );
    expect(stamps.map((s) => s.meta.sourceVersionValue).sort()).toEqual(['r1', 'r2']);
  });

  it('a full walk marks a dropped item gone and the close policy stamps validUntil on its facts', async () => {
    source.items.delete('onboarding');
    const r = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true, full: true });
    expect(r.body.summary).toMatchObject({ mode: 'full', seen: 1, gone: 1, fetched: 0 });
    expect(r.body.summary.closed).toBeGreaterThanOrEqual(1);

    const gone = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items?state=gone`)
      .set(auth());
    expect(gone.body.items.map((i: { externalId: string }) => i.externalId)).toEqual([
      'onboarding',
    ]);
    expect(gone.body.items[0].goneAt).not.toBeNull();

    const closed = await rows<{ validUntil: unknown }>(
      `SELECT validUntil FROM knowledge_fact WHERE source.documentId = $docId`,
      { docId: gone.body.items[0].documentId },
    );
    expect(closed.length).toBeGreaterThanOrEqual(1);
    for (const fact of closed) expect(fact.validUntil).not.toBeNull();
  });

  it('pause skips by name; delete removes the catalogue and keeps the documents', async () => {
    const paused = await f.http
      .patch(`/v1/admin/source-connections/${connectionId}`)
      .set(auth())
      .send({ status: 'paused' });
    expect(paused.body.status).toBe('paused');
    const skipped = await f.http
      .post(`/v1/admin/source-connections/${connectionId}/sync`)
      .set(auth())
      .send({ inline: true });
    expect(skipped.body.summary).toMatchObject({ status: 'skipped', skipped: 'status_paused' });

    const del = await f.http.delete(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(del.body).toEqual({ deleted: true, items: 2 });
    expect(
      (await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth())).status,
    ).toBe(404);
    const docs = await rows<{ id: unknown }>(
      `SELECT id FROM source_document WHERE kind = 'source_document'`,
    );
    expect(docs).toHaveLength(3);
  });
});
