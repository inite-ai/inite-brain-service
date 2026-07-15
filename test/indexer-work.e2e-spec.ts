/**
 * E2E for the external-indexer work-discovery surface (/v1/indexer/work,
 * scope indexer:write): ingest routes a document to an external pack and
 * pre-creates a pull work item; a remote indexer polls, claims, reads
 * content, and submits. Uses the builtin code_memory pack
 * (indexer.mode 'external') as the registered identity. Also pins the
 * two lifecycle invariants of 0062: external runs never defer a commit,
 * and released/abandoned claims stay discoverable.
 */
import { AppFixture, createApp } from './app-fixture';
import { CandidateCommitService } from '../src/documents/candidate-commit.service';
import { DocumentStoreService } from '../src/documents/document-store.service';

describe('indexer work discovery (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const DOC_TEXT =
    'Decision log for src/gateway.ts: route all fact writes through one ' +
    'gateway. Chosen because scattered writes drifted between call-sites.';

  beforeAll(async () => {
    f = await createApp({
      scopes: [
        'brain:read',
        'brain:write',
        'brain:admin',
        'brain:read_pii',
        'indexer:write',
      ],
    });
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    // External work items are produced by the multi-indexer router.
    process.env.DOCUMENT_MULTI_INDEXER_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.DOCUMENT_MULTI_INDEXER_ENABLED;
    await f.close();
  });

  async function createDoc(text: string, extra: Record<string, unknown> = {}) {
    // Empty extraction: the document exists purely as a Source; the
    // external indexer is the one doing the reading.
    f.extractor.setScript({ entities: [], facts: [], edges: [] });
    const r = await f.http.post('/v1/ingest/document').set(auth()).send({
      kind: 'markdown',
      text,
      occurredAt: '2026-07-01T10:00:00.000Z',
      contextRef: { vertical: 'work_e2e' },
      indexers: ['code_memory'],
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body as {
      documentId: string;
      runs: Array<{ packId: string; status: string }>;
    };
  }

  async function pollWork(query = '') {
    const r = await f.http.get(`/v1/indexer/work${query}`).set(auth());
    expect(r.status).toBe(200);
    return r.body.work as Array<{
      runId: string;
      documentId: string;
      packId: string;
      packVersion: string;
      docHasContent: boolean;
    }>;
  }

  function workFor(
    work: Array<{ documentId: string }>,
    docId: string,
  ): any[] {
    return work.filter((w) => w.documentId === docId);
  }

  const submission = (over: Record<string, unknown> = {}) => ({
    indexerId: 'code_memory',
    entities: [{ name: 'src/gateway.ts', type: 'asset' }],
    facts: [
      {
        entityIndex: 0,
        predicate: 'code_memory__decided',
        object: 'route all fact writes through one gateway',
        confidence: 0.9,
      },
    ],
    ...over,
  });

  it('plans a pull work item at ingest and never defers the commit on it', async () => {
    const body = await createDoc(DOC_TEXT);
    expect(body.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packId: 'code_memory', status: 'planned' }),
      ]),
    );

    const items = workFor(await pollWork(), body.documentId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      packId: 'code_memory',
      docHasContent: true,
    });
    expect(items[0].packVersion).toBeTruthy();

    // The 0062 invariant: the pending external run does NOT defer the
    // settled-commit path — a slow third-party poller can't hold the
    // document's memory hostage.
    const commit = f.app.get(CandidateCommitService);
    const store = f.app.get(DocumentStoreService);
    const doc = await store.getById(f.companyId, body.documentId);
    const result = await commit.commitIfRunsSettled(f.companyId, doc!);
    expect(result.deferred).toBe(false);
  });

  it('claim → content → heartbeat → submit-with-claim completes the item', async () => {
    const { documentId } = await createDoc(`${DOC_TEXT} Claim variant.`);
    const [item] = workFor(await pollWork('?packId=code_memory'), documentId);
    expect(item).toBeDefined();

    const claim = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/claim`)
      .set(auth())
      .send({});
    expect(claim.status).toBe(201);
    expect(claim.body).toMatchObject({
      runId: item.runId,
      documentId,
      packId: 'code_memory',
    });
    expect(claim.body.claimToken).toBeTruthy();
    expect(claim.body.leaseSeconds).toBeGreaterThan(0);

    // A live claim can't be stolen.
    const steal = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/claim`)
      .set(auth())
      .send({});
    expect(steal.status).toBe(409);

    const content = await f.http
      .get(`/v1/indexer/work/${encodeURIComponent(item.runId)}/content`)
      .set(auth());
    expect(content.status).toBe(200);
    expect(content.body.documentId).toBe(documentId);
    expect(content.body.vertical).toBe('work_e2e');
    const fullText = content.body.chunks
      .map((c: { text: string }) => c.text)
      .join('\n');
    expect(fullText).toContain('route all fact writes through one gateway');

    const badBeat = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/heartbeat`)
      .set(auth())
      .send({ claimToken: 'not-the-token' });
    expect(badBeat.status).toBe(409);

    const beat = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/heartbeat`)
      .set(auth())
      .send({ claimToken: claim.body.claimToken });
    expect(beat.status).toBe(201);

    const submit = await f.http
      .post(`/v1/documents/${encodeURIComponent(documentId)}/candidates`)
      .set(auth())
      .send(
        submission({
          runId: item.runId,
          claimToken: claim.body.claimToken,
        }),
      );
    expect(submit.status).toBe(201);
    expect(submit.body.runId).toBe(item.runId);
    expect(submit.body.staged.facts).toBe(1);
    expect(submit.body.commit).toMatchObject({ deferred: false });

    // The fulfilled slot is gone from discovery and terminal on the ledger.
    expect(workFor(await pollWork(), documentId)).toHaveLength(0);
    const docView = await f.http
      .get(`/v1/documents/${encodeURIComponent(documentId)}`)
      .set(auth());
    const run = docView.body.runs.find(
      (r: { packId: string }) => r.packId === 'code_memory',
    );
    expect(run.status).toBe('succeeded');
  });

  it('claimless submission absorbs the pending work item (one run, not two)', async () => {
    const { documentId } = await createDoc(`${DOC_TEXT} Claimless variant.`);
    expect(workFor(await pollWork(), documentId)).toHaveLength(1);

    const submit = await f.http
      .post(`/v1/documents/${encodeURIComponent(documentId)}/candidates`)
      .set(auth())
      .send(submission());
    expect(submit.status).toBe(201);

    expect(workFor(await pollWork(), documentId)).toHaveLength(0);
    const docView = await f.http
      .get(`/v1/documents/${encodeURIComponent(documentId)}`)
      .set(auth());
    const runs = docView.body.runs.filter(
      (r: { packId: string }) => r.packId === 'code_memory',
    );
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
  });

  it('release returns the item to the pool; permanent fail hides but stays claimable', async () => {
    const { documentId } = await createDoc(`${DOC_TEXT} Release variant.`);
    const [item] = workFor(await pollWork(), documentId);

    const claim1 = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/claim`)
      .set(auth())
      .send({});
    expect(claim1.status).toBe(201);

    const release = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/fail`)
      .set(auth())
      .send({ claimToken: claim1.body.claimToken, error: 'shutting down' });
    expect(release.status).toBe(201);
    expect(release.body.status).toBe('released');

    // Released work is discoverable again…
    expect(workFor(await pollWork(), documentId)).toHaveLength(1);

    const claim2 = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/claim`)
      .set(auth())
      .send({});
    expect(claim2.status).toBe(201);

    const permFail = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/fail`)
      .set(auth())
      .send({
        claimToken: claim2.body.claimToken,
        error: 'cannot parse this kind',
        permanent: true,
      });
    expect(permFail.status).toBe(201);
    expect(permFail.body.status).toBe('failed');

    // …a permanent fail is not offered, but a direct re-claim works
    // (deliberate retry after a fix).
    expect(workFor(await pollWork(), documentId)).toHaveLength(0);
    const claim3 = await f.http
      .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/claim`)
      .set(auth())
      .send({});
    expect(claim3.status).toBe(201);
  });

  it('fences: scope, tenant, unknown pack, claim mismatches', async () => {
    const { documentId } = await createDoc(`${DOC_TEXT} Fence variant.`);
    const [item] = workFor(await pollWork(), documentId);

    // Scope fence.
    const limited = await createApp({ scopes: ['brain:read', 'brain:write'] });
    try {
      const r = await limited.http
        .get('/v1/indexer/work')
        .set({ Authorization: `Bearer ${limited.apiKey}` });
      expect(r.status).toBe(403);
    } finally {
      await limited.close();
    }

    // Tenant fence: another tenant sees no work and can't claim ours.
    const other = await createApp({
      scopes: ['brain:read', 'indexer:write'],
    });
    try {
      const theirAuth = { Authorization: `Bearer ${other.apiKey}` };
      const list = await other.http.get('/v1/indexer/work').set(theirAuth);
      expect(list.status).toBe(200);
      expect(
        list.body.work.filter(
          (w: { documentId: string }) => w.documentId === documentId,
        ),
      ).toHaveLength(0);
      const claim = await other.http
        .post(`/v1/indexer/work/${encodeURIComponent(item.runId)}/claim`)
        .set(theirAuth)
        .send({});
      expect(claim.status).toBe(404);
    } finally {
      await other.close();
    }

    // Unknown pack filter is a 404, mirroring the submission surface.
    const unknown = await f.http
      .get('/v1/indexer/work?packId=totally_unknown')
      .set(auth());
    expect(unknown.status).toBe(404);

    // Claim-field pairing and token fencing on submit.
    const half = await f.http
      .post(`/v1/documents/${encodeURIComponent(documentId)}/candidates`)
      .set(auth())
      .send(submission({ runId: item.runId }));
    expect(half.status).toBe(400);

    const wrongToken = await f.http
      .post(`/v1/documents/${encodeURIComponent(documentId)}/candidates`)
      .set(auth())
      .send(submission({ runId: item.runId, claimToken: 'wrong' }));
    expect(wrongToken.status).toBe(409);
  });

  it('plans no work for content-less documents unless ungrounded is allowed', async () => {
    const noContent = await createDoc(`${DOC_TEXT} Private variant.`, {
      storeContent: false,
      contextRef: { vertical: 'work_private' },
    });
    expect(noContent.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packId: 'code_memory', status: 'planned' }),
      ]),
    );
    expect(workFor(await pollWork(), noContent.documentId)).toHaveLength(0);

    process.env.DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL = '1';
    try {
      const optIn = await createDoc(`${DOC_TEXT} Opt-in variant.`, {
        storeContent: false,
        contextRef: { vertical: 'work_private_optin' },
      });
      const items = workFor(await pollWork(), optIn.documentId);
      expect(items).toHaveLength(1);
      expect(items[0].docHasContent).toBe(false);

      // No stored text to serve — the indexer extracts from its own copy.
      const content = await f.http
        .get(
          `/v1/indexer/work/${encodeURIComponent(items[0].runId)}/content`,
        )
        .set(auth());
      expect(content.status).toBe(404);
    } finally {
      delete process.env.DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL;
    }
  });

  it('internal (non-external) pending runs still defer commit and are never served', async () => {
    const { documentId } = await createDoc(`${DOC_TEXT} Legacy variant.`);
    // An internal ledger row (external=false — same query behavior as a
    // pre-0062 row reading NONE: every predicate uses the NONE-tolerant
    // `!= true` / `= true` forms).
    const { SurrealService } = await import('../src/db/surreal.service');
    const surreal = f.app.get(SurrealService);
    const legacyRunId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `CREATE indexer_run SET
           docId = type::record('source_document', $doc),
           packId = 'legacy_pack', packVersion = '1', status = 'pending'
         RETURN AFTER`,
        { doc: documentId.split(':')[1] },
      );
      return String(((rows as any[]) ?? [])[0].id);
    });

    // NONE external → still a commit-blocking internal run…
    const commit = f.app.get(CandidateCommitService);
    const store = f.app.get(DocumentStoreService);
    const doc = await store.getById(f.companyId, documentId);
    const result = await commit.commitIfRunsSettled(f.companyId, doc!);
    expect(result.deferred).toBe(true);

    // …and never served as external work.
    const served = workFor(await pollWork(), documentId).map((w) => w.runId);
    expect(served).not.toContain(legacyRunId);
  });

  it('503s the whole surface when document ingest is disabled', async () => {
    process.env.DOCUMENT_INGEST_ENABLED = '0';
    try {
      const r = await f.http.get('/v1/indexer/work').set(auth());
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('feature_disabled');
    } finally {
      process.env.DOCUMENT_INGEST_ENABLED = '1';
    }
  });
});
