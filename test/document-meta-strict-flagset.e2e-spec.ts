/**
 * The production flag SET over the document-meta channel.
 *
 * Incident 2026-09-02 → 2026-09-05: every POST /v1/ingest/mention
 * answered 400 invalid_meta. Neither flag alone breaks anything, which
 * is exactly why it shipped — INGEST_MENTION_VIA_DOCUMENT and
 * SOURCE_META_STRICT were each covered alone and never as a pair.
 *
 * So this spec does not test a flag; it tests the SET. It turns on every
 * production flag that co-governs `source_document.meta` —
 *
 *   DOCUMENT_INGEST_ENABLED       (deploy-brain.yml:518)
 *   INGEST_MENTION_VIA_DOCUMENT   (deploy-brain.yml:526)
 *   SOURCE_META_STRICT            (deploy-brain.yml:287)
 *   TOOL_OBSERVATIONS_ENABLED     (deploy-brain.yml:267)
 *   POLICY_META_UNION_ENABLED     (deploy-brain.yml:288)
 *
 * — and then walks every writer into that column: the caller channel
 * (IngestDocumentDto.meta) and both internal writers (the mention
 * wrapper's contextRef identifiers, the 0111 tool-observation hop).
 *
 * The boundary being pinned: SOURCE_META_STRICT polices CALLER meta —
 * untrusted operator vocabulary bound for the ABAC `source.meta` match
 * surface. Brain's own document-header provenance is not caller input,
 * rides the internal channel (src/documents/document-meta.ts), and is
 * neither validated against that rule nor forgeable by a client.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ToolObservationService } from '../src/outcomes/tool-observation.service';
import type { ExtractionResult } from '../src/ai/extractor.service';

jest.setTimeout(180_000);

const TIER_GOLD: ExtractionResult = {
  entities: [{ name: 'Acme Corp', type: 'customer' }],
  facts: [{ entityIndex: 0, predicate: 'tier', object: 'gold', confidence: 0.9 }],
  edges: [],
};

interface DocRow {
  id: unknown;
  meta?: Record<string, unknown>;
}

describe('document meta under the production flag set', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_meta_flagset_e2e' });
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    process.env.SOURCE_META_STRICT = '1';
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    process.env.POLICY_META_UNION_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    delete process.env.SOURCE_META_STRICT;
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    delete process.env.POLICY_META_UNION_ENABLED;
    if (f) await f.close();
  });

  afterEach(() => {
    f.extractor.setScript(null);
  });

  const postMention = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({ emittedAt: '2026-09-02T10:00:00.000Z', ...body });

  const postDocument = (body: Record<string, unknown>) =>
    f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        occurredAt: '2026-09-02T10:00:00.000Z',
        contextRef: { vertical: 'meta_flagset' },
        ...body,
      });

  const docMeta = async (docId: string): Promise<Record<string, unknown> | undefined> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[DocRow[]]>(
        `SELECT meta FROM source_document WHERE id = type::record('source_document', $id)`,
        { id: docId.split(':')[1] },
      );
      return ((rows as DocRow[]) ?? [])[0]?.meta;
    });
  };

  // ── internal writer 1: the mention wrapper's contextRef identifiers ──

  it('a fully-populated contextRef ingests — brain provenance is not caller meta', async () => {
    f.extractor.setScript(TIER_GOLD);
    const res = await postMention({
      text: 'Acme upgraded to the gold tier this quarter.',
      contextRef: {
        vertical: 'meta_flagset',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        eventId: 'evt-1',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toBe(false);
    expect(res.body.extractedFactIds.length).toBeGreaterThan(0);
  });

  it('a contextRef with NO eventId ingests', async () => {
    // The original defect asserted `eventId` even when the request never
    // sent one: an object literal materialises the key for an undefined
    // value, so the sanitizer saw all three keys unconditionally. This
    // case is the proof the bag was brain's, not the caller's.
    f.extractor.setScript(TIER_GOLD);
    const res = await postMention({
      text: 'Acme stays on the gold tier next quarter.',
      contextRef: { vertical: 'meta_flagset', conversationId: 'conv-2' },
    });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toBe(false);
  });

  it('a bare contextRef (vertical only) ingests', async () => {
    f.extractor.setScript(TIER_GOLD);
    const res = await postMention({
      text: 'Acme renewed for another year on gold.',
      contextRef: { vertical: 'meta_flagset' },
    });
    expect(res.status).toBe(201);
  });

  it('the identifiers still land on the stored header, absent ones omitted', async () => {
    // The stored shape is UNCHANGED by the fix — the same three keys in
    // the same column — so the rows written between 2026-07-09 and
    // 2026-09-02 stay readable and nothing is orphaned.
    f.extractor.setScript(TIER_GOLD);
    const res = await postMention({
      text: 'Acme confirmed the gold tier in writing.',
      contextRef: { vertical: 'meta_flagset', conversationId: 'conv-3', messageId: 'msg-3' },
    });
    expect(res.status).toBe(201);
    const surreal = f.app.get(SurrealService);
    const stored = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[DocRow[]]>(
        `SELECT meta FROM source_document WHERE meta.conversationId = 'conv-3' LIMIT 1`,
      );
      return ((rows as DocRow[]) ?? [])[0]?.meta;
    });
    expect(stored).toEqual({ conversationId: 'conv-3', messageId: 'msg-3' });
    expect(Object.prototype.hasOwnProperty.call(stored ?? {}, 'eventId')).toBe(false);
  });

  it('a metadata-free document keeps a header with no meta at all', async () => {
    f.extractor.setScript(TIER_GOLD);
    const res = await postDocument({ text: 'Acme is on the gold tier, per the contract.' });
    expect(res.status).toBe(201);
    expect(await docMeta(res.body.documentId as string)).toBeUndefined();
  });

  // ── internal writer 2: the 0111 tool-observation hop ──────────────────

  it('a verified toolObservationRef ingests and keeps its evidence hop', async () => {
    const observations = f.app.get(ToolObservationService);
    observations.record(f.companyId, {
      tool: 'web_fetch',
      args: { url: 'https://example.com/report' },
      result: { status: 200 },
      ok: true,
      durationMs: 12,
    });
    const surreal = f.app.get(SurrealService);
    let ref = '';
    for (let i = 0; i < 40 && ref === ''; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ref = await surreal.withCompany(f.companyId, async (db) => {
        // SurrealDB 3.2.4 wants the ORDER BY idiom in the selection.
        const [rows] = await db.query<[Array<{ id: unknown }>]>(
          'SELECT id, createdAt FROM tool_observation ORDER BY createdAt DESC LIMIT 1',
        );
        const row = ((rows as Array<{ id: unknown }>) ?? [])[0];
        return row ? String(row.id) : '';
      });
    }
    expect(ref).toMatch(/^tool_observation:/);

    f.extractor.setScript(TIER_GOLD);
    const res = await postDocument({
      text: 'Fetched report: Acme holds the gold tier.',
      toolObservationRef: ref,
    });
    // Class member 2: brain synthesises toolObservationRef +
    // toolObservationNote onto the header exactly like the mention
    // wrapper did, so TOOL_OBSERVATIONS_ENABLED × SOURCE_META_STRICT was
    // the same 400 on POST /v1/ingest/document.
    expect(res.status).toBe(201);
    expect(await docMeta(res.body.documentId as string)).toMatchObject({
      toolObservationRef: ref,
      toolObservationNote: expect.stringMatching(/^web_fetch @ /) as unknown as string,
    });
  });

  // ── the caller channel is unchanged, and not forgeable ───────────────

  it('CALLER-supplied non-operator meta is still rejected — the gate stands', async () => {
    const res = await postDocument({
      text: 'A document whose operator meta is not operator vocabulary.',
      meta: { dataClass: 'pii' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_meta');
    expect(res.body.issues[0]).toContain("key 'dataClass' is not snake_case");
  });

  it('well-formed caller meta still rides through to the header', async () => {
    f.extractor.setScript(TIER_GOLD);
    const res = await postDocument({
      text: 'An operator-tagged note about Acme and the gold tier.',
      meta: { data_class: 'pii', department: 'people' },
    });
    expect(res.status).toBe(201);
    expect(await docMeta(res.body.documentId as string)).toEqual({
      data_class: 'pii',
      department: 'people',
    });
  });
});
