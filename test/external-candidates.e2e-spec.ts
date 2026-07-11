/**
 * E2E for the external-indexer seam: POST /v1/documents/:id/candidates
 * under the narrow indexer:write scope. Uses the builtin code_memory
 * pack (indexer.mode 'external') as the registered identity. Covers:
 * scope fence, binding checks (unknown pack / non-external pack),
 * namespace fence, server-side re-grounding against stored text, the
 * run-ledger 409 on duplicate submission, and the settled commit.
 */
import { AppFixture, createApp } from './app-fixture';

describe('external candidates (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const DOC_TEXT =
    'Decision log for src/resolver.ts: resolve facts through one gateway. ' +
    'Chosen because positional args drifted between call-sites.';

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
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    await f.close();
  });

  async function createDoc(text: string, extra: Record<string, unknown> = {}) {
    // Empty extraction: the document exists purely as a Source for the
    // external indexer to read.
    f.extractor.setScript({ entities: [], facts: [], edges: [] });
    const r = await f.http.post('/v1/ingest/document').set(auth()).send({
      kind: 'markdown',
      text,
      occurredAt: '2026-07-01T10:00:00.000Z',
      contextRef: { vertical: 'ext_e2e' },
      ...extra,
    });
    expect(r.status).toBe(201);
    return r.body.documentId as string;
  }

  const submission = (over: Record<string, unknown> = {}) => ({
    indexerId: 'code_memory',
    entities: [{ name: 'src/resolver.ts', type: 'asset' }],
    facts: [
      {
        entityIndex: 0,
        predicate: 'code_memory__decided',
        object: 'resolve facts through one gateway',
        confidence: 0.9,
      },
    ],
    ...over,
  });

  it('requires the indexer:write scope', async () => {
    const limited = await createApp({ scopes: ['brain:read', 'brain:write'] });
    try {
      const r = await limited.http
        .post('/v1/documents/source_document:whatever/candidates')
        .set({ Authorization: `Bearer ${limited.apiKey}` })
        .send(submission());
      expect(r.status).toBe(403);
    } finally {
      await limited.close();
    }
  });

  it('stages grounded candidates, drops fabricated spans, and commits', async () => {
    const docId = await createDoc(DOC_TEXT);
    const r = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(
        submission({
          facts: [
            {
              entityIndex: 0,
              predicate: 'code_memory__decided',
              object: 'resolve facts through one gateway',
              confidence: 0.9,
            },
            {
              // Fabricated: this value never appears in the document.
              entityIndex: 0,
              predicate: 'code_memory__gotcha',
              object: 'never call the resolver twice',
              confidence: 0.9,
            },
          ],
        }),
      );
    expect(r.status).toBe(201);
    expect(r.body.packId).toBe('code_memory');
    expect(r.body.ungrounded).toBe(false);
    expect(r.body.staged).toMatchObject({ entities: 1, facts: 1 });
    expect(r.body.dropped).toEqual([
      expect.objectContaining({ kind: 'fact', reason: 'ungrounded_value' }),
    ]);
    expect(r.body.commit).toMatchObject({ deferred: false, committed: true });
    expect(r.body.commit.counts.committed).toBeGreaterThan(0);
  });

  it('409s a duplicate submission for the same pack version (run ledger)', async () => {
    const docId = await createDoc(`${DOC_TEXT} Dedupe variant.`);
    const first = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(submission());
    expect(first.status).toBe(201);

    const second = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(submission());
    expect(second.status).toBe(409);
  });

  it('stamps the INSTALLED pack version on provenance when packVersion is omitted', async () => {
    const docId = await createDoc(`${DOC_TEXT} Provenance variant.`);
    const r = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(submission()); // no packVersion in the body
    expect(r.status).toBe(201);
    // The response echoes the resolved installed version…
    expect(r.body.packVersion).toBe('0.2.0');

    // …and the PERSISTED candidate provenance must match it, not the '0'
    // fallback the omitted-packVersion path used to stamp.
    const { SurrealService } = await import('../src/db/surreal.service');
    const surreal = f.app.get(SurrealService);
    const versions = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ v: unknown }>]>(
        `SELECT payload.packVersion AS v FROM candidate
           WHERE docId = type::record('source_document', $doc) AND kind = 'fact'`,
        { doc: docId.split(':')[1] },
      );
      return ((rows as Array<{ v: unknown }>) ?? []).map((x) => String(x.v));
    });
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v).toBe('0.2.0');
  });

  it('rejects predicates outside the indexer namespace', async () => {
    const docId = await createDoc(`${DOC_TEXT} Namespace variant.`);
    const r = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(
        submission({
          facts: [
            {
              entityIndex: 0,
              predicate: 'real_estate__zoned_as',
              object: 'one gateway',
              confidence: 0.9,
            },
          ],
        }),
      );
    expect(r.status).toBe(400);
  });

  it('404s an unregistered indexer pack', async () => {
    const docId = await createDoc(`${DOC_TEXT} Unknown pack variant.`);
    const r = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(submission({ indexerId: 'totally_unknown' }));
    expect(r.status).toBe(404);
  });

  it('rejects storeContent:false submissions by default (spans unverifiable)', async () => {
    const docId = await createDoc(`${DOC_TEXT} Private variant.`, {
      storeContent: false,
      contextRef: { vertical: 'ext_private' },
    });
    const r = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(submission());
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL/);
  });

  it('stages ungrounded (flagged) candidates when explicitly opted in', async () => {
    process.env.DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL = '1';
    try {
      const docId = await createDoc(`${DOC_TEXT} Opt-in variant.`, {
        storeContent: false,
        contextRef: { vertical: 'ext_private_optin' },
      });
      const r = await f.http
        .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
        .set(auth())
        .send(submission());
      expect(r.status).toBe(201);
      expect(r.body.ungrounded).toBe(true);
      expect(r.body.staged.facts).toBe(1);

      const cands = await f.http
        .get(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
        .set(auth());
      const fact = cands.body.candidates.find(
        (c: { kind: string }) => c.kind === 'fact',
      );
      expect(fact.payload.ungrounded).toBe(true);
    } finally {
      delete process.env.DOCUMENT_ALLOW_UNGROUNDED_EXTERNAL;
    }
  });

  it('rejects a scope-gated core predicate from an external indexer', async () => {
    const docId = await createDoc(`${DOC_TEXT} Address 12 Baker St.`);
    const r = await f.http
      .post(`/v1/documents/${encodeURIComponent(docId)}/candidates`)
      .set(auth())
      .send(
        submission({
          facts: [
            {
              entityIndex: 0,
              predicate: 'address',
              object: '12 Baker St',
              confidence: 0.9,
            },
          ],
        }),
      );
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/scope-gated core predicate/);
  });
});
