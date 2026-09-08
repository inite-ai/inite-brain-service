/**
 * E2E for the read-only operator view over installed indexers
 * (GET /v1/admin/indexers, INDEXER_OPERATOR_VIEW_ENABLED) — end to end on
 * a real DB, mirroring the sibling indexer/document suites.
 *
 * Proves the gap it closes: ingest routes a document to the builtin
 * external pack (code_memory), the run ledger records it, and an OPERATOR
 * — not the poller — can see which indexers the tenant has, what their
 * last run did, and whether the external publisher is polling. Also pins
 * the fences: 404 while the flag is off, a pack with no `indexer`
 * descriptor absent from the list, and an unknown pack 404 on the detail
 * route.
 */
import { AppFixture, createApp } from './app-fixture';

const PLAIN_MANIFEST = {
  id: 'medical',
  version: '1.0.0',
  // No `indexer` descriptor: this pack rides the union pass and has no
  // run ledger of its own, so the operator view must NOT list it.
  description: 'Medical domain ontology (test pack, no indexer descriptor).',
  predicates: [
    {
      localId: 'diagnosis',
      displayLabel: 'diagnosis',
      description: 'TYPE subject is a patient; value is a diagnosis',
      datatype: 'string',
      semantics: 'append_only',
      decayHalfLifeDays: null,
      piiClass: 'sensitive',
      status: 'active',
    },
  ],
};

interface Overview {
  packId: string;
  packVersion: string;
  mode: string;
  source: string;
  lastRun: { runId: string; status: string; documentId: string } | null;
  runs: { total: number; pending: number; succeeded: number; failed: number };
  candidates: { submitted: number; committed: number; rejected: number };
  external: {
    publisher: string | null;
    pendingWork: number;
    oldestPendingAt: string | null;
    lastClaimAt: string | null;
    polledRecently: boolean;
  } | null;
  truncated: boolean;
}

describe('indexer operator view (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const DOC_TEXT =
    'Decision log for src/router.ts: the relevance router gates dedicated ' +
    'indexer runs so pack fan-out cannot blow the LLM budget.';

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_indexer_operator_e2e',
      scopes: ['brain:read', 'brain:write', 'brain:admin', 'brain:read_pii', 'indexer:write'],
    });
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    // External work items are produced by the multi-indexer router.
    process.env.DOCUMENT_MULTI_INDEXER_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.DOCUMENT_MULTI_INDEXER_ENABLED;
    delete process.env.INDEXER_OPERATOR_VIEW_ENABLED;
    if (f) await f.close();
  });

  async function view(query = ''): Promise<Overview[]> {
    const r = await f.http.get(`/v1/admin/indexers${query}`).set(auth());
    expect(r.status).toBe(200);
    return r.body.indexers as Overview[];
  }

  it('404s both routes while the flag is off', async () => {
    delete process.env.INDEXER_OPERATOR_VIEW_ENABLED;
    expect((await f.http.get('/v1/admin/indexers').set(auth())).status).toBe(404);
    expect((await f.http.get('/v1/admin/indexers/code_memory/runs').set(auth())).status).toBe(404);
  });

  it('lists the tenant’s declared indexers once the flag is on', async () => {
    process.env.INDEXER_OPERATOR_VIEW_ENABLED = '1';
    const r = await f.http.get('/v1/admin/indexers').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.tenant).toBe('co_indexer_operator_e2e');
    expect(r.body.window).toMatchObject({ days: 7, runCap: 50 });
    expect(typeof r.body.window.since).toBe('string');

    const code = (r.body.indexers as Overview[]).find((i) => i.packId === 'code_memory');
    expect(code).toBeDefined();
    expect(code?.mode).toBe('external');
    expect(code?.source).toBe('builtin');
    expect(code?.packVersion.length).toBeGreaterThan(0);
    // An idle indexer is still listed — with an empty ledger, not absent.
    expect(code?.external).not.toBeNull();
    expect(code?.truncated).toBe(false);
  });

  it('omits an installed pack that declares no indexer descriptor', async () => {
    process.env.INDEXER_OPERATOR_VIEW_ENABLED = '1';
    const install = await f.http
      .post('/v1/admin/packs')
      .set(auth())
      .send({ manifest: PLAIN_MANIFEST });
    expect([200, 201]).toContain(install.status);

    const packs = await view();
    expect(packs.map((i) => i.packId)).toContain('code_memory');
    expect(packs.map((i) => i.packId)).not.toContain('medical');
  });

  it('surfaces the run ledger and publisher liveness for an external pack', async () => {
    process.env.INDEXER_OPERATOR_VIEW_ENABLED = '1';
    f.extractor.setScript({ entities: [], facts: [], edges: [] });
    const ingest = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text: DOC_TEXT,
        occurredAt: '2026-07-01T10:00:00.000Z',
        contextRef: { vertical: 'operator_e2e' },
        indexers: ['code_memory'],
      });
    expect(ingest.status).toBe(201);
    const documentId = ingest.body.documentId as string;

    const before = (await view()).find((i) => i.packId === 'code_memory');
    expect(before?.runs.total).toBeGreaterThanOrEqual(1);
    expect(before?.runs.pending).toBeGreaterThanOrEqual(1);
    expect(before?.lastRun).not.toBeNull();
    expect(before?.lastRun?.documentId).toBe(documentId);
    expect(before?.lastRun?.status).toBe('pending');
    // Unclaimed work with no claim ever seen = the publisher is not polling.
    expect(before?.external?.pendingWork).toBeGreaterThanOrEqual(1);
    expect(before?.external?.oldestPendingAt).not.toBeNull();
    expect(before?.external?.lastClaimAt).toBeNull();
    expect(before?.external?.polledRecently).toBe(false);

    // The publisher polls and claims — the operator view must notice.
    const work = await f.http.get('/v1/indexer/work?packId=code_memory').set(auth());
    expect(work.status).toBe(200);
    const item = (work.body.work as Array<{ runId: string; documentId: string }>).find(
      (w) => w.documentId === documentId,
    );
    expect(item).toBeDefined();
    const claim = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item!.runId)}/claim`)
      .set(auth());
    expect(claim.status).toBe(201);

    const after = (await view()).find((i) => i.packId === 'code_memory');
    expect(after?.external?.lastClaimAt).not.toBeNull();
    expect(after?.external?.polledRecently).toBe(true);
    expect(after?.runs.total).toBeGreaterThanOrEqual(1);
    expect(after?.lastRun?.status).toBe('running');
  });

  it('lists recent runs of one indexer and clamps the window', async () => {
    process.env.INDEXER_OPERATOR_VIEW_ENABLED = '1';
    const r = await f.http
      .get('/v1/admin/indexers/code_memory/runs?days=9999&limit=9999')
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.packId).toBe('code_memory');
    expect(r.body.window).toMatchObject({ days: 90, runCap: 200 });
    expect(Array.isArray(r.body.runs)).toBe(true);
    expect(r.body.runs.length).toBeGreaterThanOrEqual(1);
    expect(r.body.truncated).toBe(false);
    const run = r.body.runs[0] as { runId: string; packVersion: string; candidates: unknown };
    expect(typeof run.runId).toBe('string');
    expect(typeof run.packVersion).toBe('string');
    expect(run.candidates).toMatchObject({ submitted: expect.any(Number) });
  });

  it('404s the detail route for a pack that is not a declared indexer', async () => {
    process.env.INDEXER_OPERATOR_VIEW_ENABLED = '1';
    expect((await f.http.get('/v1/admin/indexers/medical/runs').set(auth())).status).toBe(404);
    expect((await f.http.get('/v1/admin/indexers/nope/runs').set(auth())).status).toBe(404);
  });

  it('denies a plain admin asking for another tenant', async () => {
    process.env.INDEXER_OPERATOR_VIEW_ENABLED = '1';
    const r = await f.http.get('/v1/admin/indexers?tenant=co_someone_else').set(auth());
    expect(r.status).toBe(403);
  });
});
