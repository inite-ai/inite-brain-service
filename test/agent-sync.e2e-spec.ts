/**
 * The agent protocol (W3) end to end against a REAL SurrealDB — the
 * server side of "one connector runtime, two hosts": the agent walks
 * and fetches on its own machine, the engine keeps the books here.
 *  - an agent-host connection needs no server connector (SOURCE_KIND_FS
 *    stays off) and is listed to its agent with the pack entry;
 *  - begin ⇒ full on the first run; deltas ⇒ what to fetch; items go
 *    through the document door under the connection's recorder and
 *    stamp; finish ⇒ checkpoint recorded, summary = the job_run result;
 *  - an incremental run: only a moved revision is fetched, an explicit
 *    gone closes; a full run marks what it did not see gone and the
 *    close policy stamps validUntil;
 *  - the fences: wrong agent ⇒ 404, two runs at once ⇒ 409, a finished
 *    run ⇒ 409, an uncatalogued item ⇒ 404, the manifest policy ⇒ skipped.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

const COMPANY = 'co_agent_sync_e2e';
const AGENT = 'laptop-1';
const HOST = `agent:${AGENT}`;

const PACK = {
  id: 'notes_pack',
  version: '1.0.0',
  description: 'Agent protocol e2e pack.',
  predicates: [
    {
      localId: 'note_says',
      displayLabel: 'note says',
      description: 'TYPE subject is a topic; value is a note',
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
    },
  ],
  sources: [
    {
      id: 'notes',
      kind: 'native',
      connector: 'fs',
      shape: 'document',
      defaults: { contentPolicy: 'text' },
    },
    {
      id: 'listing',
      kind: 'native',
      connector: 'fs',
      shape: 'document',
      defaults: { contentPolicy: 'manifest' },
    },
  ],
};

describe('agent sync protocol (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const saved: Record<string, string | undefined> = {};
  let connectionId = '';
  let listingId = '';

  beforeAll(async () => {
    for (const k of [
      'SOURCE_PLANE_ENABLED',
      'DOCUMENT_INGEST_ENABLED',
      'WORKER_LOOP_ENABLED',
      'SOURCE_KIND_FS',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.WORKER_LOOP_ENABLED = '0';
    process.env.SOURCE_PLANE_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    delete process.env.SOURCE_KIND_FS;
    f = await createApp({ companyId: COMPANY });
    const installed = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: PACK, acceptSources: true });
    expect([200, 201]).toContain(installed.status);
    for (const [sourceId, label] of [
      ['notes', 'Laptop notes'],
      ['listing', 'Listing only'],
    ] as const) {
      const r = await f.http
        .post('/v1/admin/source-connections')
        .set(auth())
        .send({
          packId: 'notes_pack',
          sourceId,
          vertical: 'notes',
          label,
          host: HOST,
          config: { root: '/Users/me/notes' },
        });
      expect(r.status).toBe(201);
      if (sourceId === 'notes') connectionId = r.body.id;
      else listingId = r.body.id;
    }
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
  const post = (path: string, body: object) =>
    f.http.post(`/v1/source-connections/${connectionId}${path}`).set(auth()).send(body);
  const doc = (text: string, title: string) => ({ shape: 'document', text, title, kind: 'file' });
  const item = (externalId: string, revision: string) => ({
    type: 'upsert',
    item: {
      externalId,
      path: externalId,
      title: externalId,
      mediaType: 'text/markdown',
      revision,
      originUri: `file:///Users/me/notes/${externalId}`,
    },
  });

  it('lists the agent host’s connections with their pack entries; a server host sees none', async () => {
    const mine = await f.http.get('/v1/source-connections').query({ host: HOST }).set(auth());
    expect(mine.status).toBe(200);
    expect(mine.body.connections).toHaveLength(2);
    const notes = mine.body.connections.find(
      (c: { connection: { id: string } }) => c.connection.id === connectionId,
    );
    expect(notes.connection).toMatchObject({ host: HOST, connector: 'fs', shape: 'document' });
    expect(notes.source).toMatchObject({ id: 'notes', kind: 'native', connector: 'fs' });
    const other = await f.http
      .get('/v1/source-connections')
      .query({ host: 'agent:other' })
      .set(auth());
    expect(other.body.connections).toEqual([]);
    const bad = await f.http.get('/v1/source-connections').query({ host: 'server' }).set(auth());
    expect(bad.status).toBe(400);
  });

  let firstRun = '';

  it('first run: begin is full, deltas name what to fetch, items land through the door, finish records the checkpoint', async () => {
    const begun = await post('/agent-runs', { agentId: AGENT });
    expect(begun.status).toBe(201);
    expect(begun.body).toMatchObject({
      full: true,
      checkpoint: null,
      contentPolicy: 'text',
      fetchBudget: null,
    });
    firstRun = begun.body.runId;

    const deltas = await post(`/agent-runs/${firstRun}/deltas`, {
      deltas: [
        item('readme.md', 'r1'),
        item('guide/onboarding.md', 'r1'),
        item('vendors.md', 'r1'),
        { type: 'checkpoint', checkpoint: { files: 3 } },
      ],
    });
    if (deltas.status !== 201) throw new Error(JSON.stringify(deltas.body));
    expect(deltas.body).toMatchObject({ seen: 3, new: 3, changed: 0, unchanged: 0, gone: 0 });
    expect([...deltas.body.fetch].sort()).toEqual([
      'guide/onboarding.md',
      'readme.md',
      'vendors.md',
    ]);

    for (const [id, text] of [
      ['readme.md', 'Acme Robotics was founded in 2019 in Tallinn.'],
      ['guide/onboarding.md', 'New engineers pair with a buddy for two weeks.'],
      ['vendors.md', 'Preferred vendor for motors: Nidec.'],
    ] as const) {
      const r = await post(`/agent-runs/${firstRun}/items`, {
        externalId: id,
        item: doc(text, id),
      });
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ status: 'ingested' });
    }

    const finished = await post(`/agent-runs/${firstRun}/finish`, { status: 'succeeded' });
    expect(finished.status).toBe(201);
    expect(finished.body).toMatchObject({
      mode: 'full',
      status: 'succeeded',
      seen: 3,
      new: 3,
      fetched: 3,
      ingested: 3,
      gone: 0,
      closed: 0,
    });

    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body).toMatchObject({ lastSyncStatus: 'succeeded', checkpoint: { files: 3 } });
    const items = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items`)
      .set(auth());
    expect(items.body.items.every((i: { state: string }) => i.state === 'indexed')).toBe(true);
    // The job cockpit shows the run as the agent's, with the summary as its result.
    const job = await f.http.get(`/v1/admin/jobs/${firstRun}`).set(auth());
    expect(job.body).toMatchObject({
      jobType: 'source_sync',
      status: 'succeeded',
      triggeredByActor: HOST,
    });
    expect(job.body.result).toMatchObject({ ingested: 3 });
    // Facts carry the stamp from the agent's revision.
    const facts = await rows<{ source: { sourceVersion?: { system: string; version: string } } }>(
      `SELECT source FROM knowledge_fact WHERE source.meta.source_connection != NONE`,
    );
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0]!.source.sourceVersion).toMatchObject({ system: 'fs', version: 'r1' });
  });

  it('incremental run: only a moved revision is fetched; an explicit gone closes; the fences hold', async () => {
    const begun = await post('/agent-runs', { agentId: AGENT });
    expect(begun.body).toMatchObject({ full: false, checkpoint: { files: 3 } });
    const runId = begun.body.runId as string;
    // A second begin while running is a conflict; a wrong agent is a 404.
    expect((await post('/agent-runs', { agentId: AGENT })).status).toBe(409);
    expect((await post('/agent-runs', { agentId: 'someone-else' })).status).toBe(404);

    const deltas = await post(`/agent-runs/${runId}/deltas`, {
      deltas: [
        item('readme.md', 'r2'),
        item('guide/onboarding.md', 'r1'),
        { type: 'gone', externalId: 'vendors.md' },
      ],
    });
    expect(deltas.body).toMatchObject({
      seen: 2,
      new: 0,
      changed: 1,
      unchanged: 1,
      gone: 1,
      fetch: ['readme.md'],
    });
    const uncatalogued = await post(`/agent-runs/${runId}/items`, {
      externalId: 'nope.md',
      item: doc('x', 'x'),
    });
    expect(uncatalogued.status).toBe(404);
    const changed = await post(`/agent-runs/${runId}/items`, {
      externalId: 'readme.md',
      item: doc(
        'Acme Robotics was founded in 2019 in Tallinn. The CTO is Maria Lind.',
        'readme.md',
      ),
    });
    expect(changed.body).toEqual({ status: 'ingested' });

    const finished = await post(`/agent-runs/${runId}/finish`, {
      status: 'succeeded',
      checkpoint: { files: 2 },
    });
    expect(finished.body).toMatchObject({
      mode: 'incremental',
      seen: 2,
      changed: 1,
      unchanged: 1,
      gone: 1,
      fetched: 1,
      ingested: 1,
    });
    expect(finished.body.closed).toBeGreaterThanOrEqual(1);
    // A finished run takes no more calls.
    expect((await post(`/agent-runs/${runId}/deltas`, { deltas: [item('x', '1')] })).status).toBe(
      409,
    );

    const gone = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items?state=gone`)
      .set(auth());
    expect(gone.body.items.map((i: { externalId: string }) => i.externalId)).toEqual([
      'vendors.md',
    ]);
    const closed = await rows<{ validUntil: unknown }>(
      `SELECT validUntil FROM knowledge_fact WHERE source.documentId = $docId`,
      { docId: gone.body.items[0].documentId },
    );
    expect(closed.length).toBeGreaterThanOrEqual(1);
    for (const fact of closed) expect(fact.validUntil).not.toBeNull();
  });

  it('a full run marks what it did not see gone; a failed run records the error; manifest policy skips content', async () => {
    const begun = await post('/agent-runs', { agentId: AGENT, full: true });
    expect(begun.body.full).toBe(true);
    const runId = begun.body.runId as string;
    await post(`/agent-runs/${runId}/deltas`, { deltas: [item('readme.md', 'r2')] });
    const finished = await post(`/agent-runs/${runId}/finish`, { status: 'succeeded' });
    expect(finished.body).toMatchObject({ mode: 'full', seen: 1, unchanged: 1, gone: 1 });
    const gone = await f.http
      .get(`/v1/admin/source-connections/${connectionId}/items?state=gone`)
      .set(auth());
    expect(gone.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual([
      'guide/onboarding.md',
      'vendors.md',
    ]);

    const failing = await post('/agent-runs', { agentId: AGENT });
    const failed = await post(`/agent-runs/${failing.body.runId}/finish`, {
      status: 'failed',
      error: 'disk unplugged',
    });
    expect(failed.body).toMatchObject({ status: 'failed', error: 'disk unplugged' });
    const conn = await f.http.get(`/v1/admin/source-connections/${connectionId}`).set(auth());
    expect(conn.body).toMatchObject({ lastSyncStatus: 'failed', lastError: 'disk unplugged' });

    // The manifest-only connection catalogues but never takes content.
    const listing = await f.http
      .post(`/v1/source-connections/${listingId}/agent-runs`)
      .set(auth())
      .send({ agentId: AGENT });
    expect(listing.body.contentPolicy).toBe('manifest');
    const lr = listing.body.runId as string;
    const ld = await f.http
      .post(`/v1/source-connections/${listingId}/agent-runs/${lr}/deltas`)
      .set(auth())
      .send({ deltas: [item('a.md', '1')] });
    expect(ld.body.fetch).toEqual(['a.md']);
    const li = await f.http
      .post(`/v1/source-connections/${listingId}/agent-runs/${lr}/items`)
      .set(auth())
      .send({ externalId: 'a.md', item: doc('x', 'a') });
    expect(li.body).toMatchObject({ status: 'skipped' });
    const lf = await f.http
      .post(`/v1/source-connections/${listingId}/agent-runs/${lr}/finish`)
      .set(auth())
      .send({ status: 'succeeded' });
    expect(lf.body).toMatchObject({ seen: 1, fetched: 0 });
  });
});
