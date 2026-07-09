/**
 * E2E for the Source → Indexer → Candidates → Brain pipeline
 * (migrations 0048–0050): flag gating, sync document ingest with staged
 * candidates, contentHash dedupe + run-ledger idempotency, cross-chunk /
 * same-origin behavior, ORIGIN-keyed corroboration (two documents
 * corroborate; one document never corroborates itself), storeContent
 * privacy trade, and the mention-via-document wrapper's response parity.
 */
import { AppFixture, createApp } from './app-fixture';
import type { ExtractionResult } from '../src/ai/extractor.service';

describe('documents pipeline (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const TIER_GOLD: ExtractionResult = {
    entities: [{ name: 'Acme Corp', type: 'customer' }],
    facts: [
      { entityIndex: 0, predicate: 'tier', object: 'gold', confidence: 0.9 },
    ],
    edges: [],
  };

  beforeAll(async () => {
    f = await createApp();
    process.env.DOCUMENT_INGEST_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    await f.close();
  });

  afterEach(() => {
    f.extractor.setScript(null);
  });

  const postDocument = (body: Record<string, unknown>) =>
    f.http.post('/v1/ingest/document').set(auth()).send({
      kind: 'markdown',
      occurredAt: '2026-07-01T10:00:00.000Z',
      contextRef: { vertical: 'docs_e2e' },
      ...body,
    });

  it('answers 503 feature_disabled with the flag off', async () => {
    process.env.DOCUMENT_INGEST_ENABLED = '0';
    const r = await postDocument({ text: 'anything' });
    expect(r.status).toBe(503);
    expect(r.body.error ?? r.body.message?.error).toBeDefined();
    process.env.DOCUMENT_INGEST_ENABLED = '1';
  });

  it('ingests a document: stores, indexes via _general, commits candidates', async () => {
    f.extractor.setScript({
      entities: [
        { name: 'Acme Corp', type: 'customer' },
        { name: 'Maria', type: 'staff' },
      ],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'silver', confidence: 0.8 },
        { entityIndex: 1, predicate: 'said', object: 'hello world', confidence: 0.7 },
      ],
      edges: [
        { fromEntityIndex: 1, toEntityIndex: 0, kind: 'works_at', confidence: 0.9 },
      ],
    });
    const r = await postDocument({ text: 'Quarterly review notes for Acme.' });
    expect(r.status).toBe(201);
    expect(r.body.deduplicated).toBe(false);
    expect(r.body.chunkCount).toBe(1);
    expect(r.body.runs).toEqual([
      expect.objectContaining({ packId: '_general', status: 'succeeded' }),
    ]);
    expect(r.body.committed.entityIds).toHaveLength(2);
    expect(r.body.committed.factIds).toHaveLength(2);
    expect(r.body.committed.edgeIds).toHaveLength(1);

    const doc = await f.http
      .get(`/v1/documents/${encodeURIComponent(r.body.documentId)}`)
      .set(auth());
    expect(doc.status).toBe(200);
    expect(doc.body.status).toBe('committed');
    expect(doc.body.hasContent).toBe(true);
    expect(doc.body.runs).toHaveLength(1);

    const cands = await f.http
      .get(`/v1/documents/${encodeURIComponent(r.body.documentId)}/candidates`)
      .set(auth());
    expect(cands.status).toBe(200);
    // 2 entities + 2 facts + 1 relation staged, all decided.
    expect(cands.body.candidates).toHaveLength(5);
    for (const c of cands.body.candidates) {
      expect(['committed', 'merged']).toContain(c.status);
    }
  });

  it('re-POST of the same text dedupes the document and skips the run', async () => {
    f.extractor.setScript(TIER_GOLD);
    const text = 'Unique dedupe text: Acme is gold tier.';
    const first = await postDocument({ text });
    expect(first.status).toBe(201);
    expect(first.body.deduplicated).toBe(false);

    const second = await postDocument({ text });
    expect(second.status).toBe(201);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.documentId).toBe(first.body.documentId);
    expect(second.body.runs).toEqual([
      expect.objectContaining({ packId: '_general', status: 'skipped' }),
    ]);
    // Nothing new to commit — the pending set was already decided.
    expect(second.body.committed.factIds).toHaveLength(0);
  });

  it('same claim from a SECOND document corroborates (origin-keyed, 0050)', async () => {
    f.extractor.setScript(TIER_GOLD);
    const docA = await postDocument({
      text: 'Meeting notes: Acme confirmed as gold tier.',
      contextRef: { vertical: 'docs_corr' },
    });
    expect(docA.status).toBe(201);
    expect(docA.body.committed.factIds).toHaveLength(1);

    // Different text (different contentHash → different originKey), same
    // extracted claim → independent confirmation, not a duel.
    const docB = await postDocument({
      text: 'Email from account manager: Acme tier is gold.',
      contextRef: { vertical: 'docs_corr' },
    });
    expect(docB.status).toBe(201);

    const cands = await f.http
      .get(`/v1/documents/${encodeURIComponent(docB.body.documentId)}/candidates`)
      .set(auth());
    const factCand = cands.body.candidates.find(
      (c: { kind: string }) => c.kind === 'fact',
    );
    // Committed fact candidates carry the resolver outcome as statusReason.
    expect(factCand.status).toBe('committed');
    expect(factCand.statusReason).toBe('CORROBORATED');
  });

  it('a document never corroborates itself (same origin, e.g. chunk overlap)', async () => {
    // Two candidates for the same claim inside ONE document collapse in
    // the pre-resolver merge — one knowledge_fact, provenance from both.
    f.extractor.setScript({
      entities: [{ name: 'Globex', type: 'customer' }],
      facts: [
        { entityIndex: 0, predicate: 'tier', object: 'silver', confidence: 0.7 },
        { entityIndex: 0, predicate: 'tier', object: 'silver', confidence: 0.9 },
      ],
      edges: [],
    });
    const r = await postDocument({
      text: 'Globex tier review, silver confirmed twice in one document.',
      contextRef: { vertical: 'docs_selfcorr' },
    });
    expect(r.status).toBe(201);
    expect(r.body.committed.factIds).toHaveLength(1);

    const cands = await f.http
      .get(`/v1/documents/${encodeURIComponent(r.body.documentId)}/candidates`)
      .set(auth());
    const factCands = cands.body.candidates.filter(
      (c: { kind: string }) => c.kind === 'fact',
    );
    expect(factCands).toHaveLength(2);
    const statuses = factCands.map((c: { status: string }) => c.status).sort();
    expect(statuses).toEqual(['committed', 'merged']);
    const committed = factCands.find(
      (c: { status: string }) => c.status === 'committed',
    );
    // INSERTED, not CORROBORATED — same origin is refresh, not evidence.
    expect(committed.statusReason).toBe('INSERTED');
  });

  it('storeContent:false keeps only the header — no chunks to read back', async () => {
    f.extractor.setScript(TIER_GOLD);
    const r = await postDocument({
      text: 'Sensitive contract body that must not persist.',
      storeContent: false,
      contextRef: { vertical: 'docs_private' },
    });
    expect(r.status).toBe(201);
    // Extraction still ran from the in-request text.
    expect(r.body.committed.factIds).toHaveLength(1);

    const doc = await f.http
      .get(`/v1/documents/${encodeURIComponent(r.body.documentId)}?includeText=1`)
      .set(auth());
    expect(doc.body.hasContent).toBe(false);
    expect(doc.body.chunks ?? []).toHaveLength(0);
  });

  it('mention wrapper preserves the mention response contract', async () => {
    f.extractor.setScript(TIER_GOLD);
    const mention = {
      text: 'Acme upgraded to gold.',
      contextRef: { vertical: 'docs_mention' },
      emittedAt: '2026-07-02T09:00:00.000Z',
    };
    // Legacy path first.
    const legacy = await f.http.post('/v1/ingest/mention').set(auth()).send(mention);
    expect(legacy.status).toBe(201);
    expect(legacy.body.skipped).toBe(false);
    expect(Array.isArray(legacy.body.extractedEntityIds)).toBe(true);
    expect(Array.isArray(legacy.body.extractedFactIds)).toBe(true);

    // Wrapper: same contract keys, document pipeline underneath.
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    const wrapped = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({ ...mention, text: 'Acme stays gold this quarter too.' });
    process.env.INGEST_MENTION_VIA_DOCUMENT = '0';
    expect(wrapped.status).toBe(201);
    expect(wrapped.body.skipped).toBe(false);
    expect(wrapped.body.extractedEntityIds.length).toBeGreaterThan(0);
    expect(wrapped.body.extractedFactIds.length).toBeGreaterThan(0);
    expect(Array.isArray(wrapped.body.extractedEdgeIds)).toBe(true);

    // Empty text keeps the skip contract.
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    const empty = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({ ...mention, text: '   ' });
    process.env.INGEST_MENTION_VIA_DOCUMENT = '0';
    expect(empty.body).toMatchObject({
      skipped: true,
      reason: 'empty',
      extractedEntityIds: [],
      extractedFactIds: [],
    });
  });
});
