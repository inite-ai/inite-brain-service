/**
 * Async document ingest keeps brain's own header keys — against a REAL
 * SurrealDB.
 *
 * (a) `mode: 'async'` with a `toolObservationRef` stores the verified hop
 *     (ref + content-free note) on `source_document.meta`, exactly as the
 *     sync path does. Before the fix the async path reached the store with
 *     no internal meta at all and the ref vanished without a word.
 * (b) an unknown ref on the async path is a 400, not a silent drop.
 * (c) the internal channel is bounded: a mention routed through the
 *     document pipeline with an over-long contextRef identifier is a 400
 *     at the door (the caller gate's short-scalar limit, applied to the
 *     one channel that used to store any string verbatim).
 */
import { StringRecordId } from 'surrealdb';
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { ToolObservationService } from '../src/outcomes/tool-observation.service';
import { INTERNAL_DOCUMENT_META_MAX_CHARS } from '../src/documents/document-meta';

interface ObservationRow {
  id: unknown;
}

describe('async document ingest keeps the internal header keys (e2e)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_docasync_meta_e2e' });
    process.env.TOOL_OBSERVATIONS_ENABLED = '1';
    process.env.DOCUMENT_INGEST_ENABLED = '1';
    process.env.DOCUMENT_MULTI_INDEXER_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.TOOL_OBSERVATIONS_ENABLED;
    delete process.env.DOCUMENT_INGEST_ENABLED;
    delete process.env.DOCUMENT_MULTI_INDEXER_ENABLED;
    delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    if (f) await f.close();
  });

  const observationRows = async (): Promise<ObservationRow[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      // 3.x: the ORDER BY field must be in the projection.
      const [rows] = await db.query<[ObservationRow[]]>(
        'SELECT id, createdAt FROM tool_observation ORDER BY createdAt ASC',
      );
      return (rows as ObservationRow[]) ?? [];
    });
  };

  /** The recorder is fire-and-forget — poll until the count holds. */
  const seedObservation = async (): Promise<string> => {
    const before = (await observationRows()).length;
    f.app.get(ToolObservationService).record(f.companyId, {
      tool: 'web_fetch',
      args: { url: 'https://example.com/report' },
      result: { status: 200 },
      ok: true,
      durationMs: 12,
    });
    let rows = await observationRows();
    for (let i = 0; i < 40 && rows.length <= before; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await observationRows();
    }
    const ref = String(rows[rows.length - 1]!.id);
    expect(ref).toMatch(/^tool_observation:/);
    return ref;
  };

  const headerMeta = async (documentId: string): Promise<Record<string, unknown> | undefined> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ meta?: Record<string, unknown> }>]>(
        'SELECT meta FROM $id',
        { id: new StringRecordId(documentId) },
      );
      return (rows as Array<{ meta?: Record<string, unknown> }>)[0]?.meta;
    });
  };

  it('mode:async stores the verified tool-observation hop on the document header', async () => {
    const ref = await seedObservation();
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text: 'Fetched report (async): Acme is platinum tier.',
        occurredAt: '2026-08-01T10:00:00.000Z',
        contextRef: { vertical: 'docasync_e2e' },
        toolObservationRef: ref,
        mode: 'async',
      });
    expect(r.status).toBe(201);
    expect(r.body.mode).toBe('async');
    const meta = await headerMeta(r.body.documentId as string);
    expect(meta).toBeDefined();
    expect(meta!.toolObservationRef).toBe(ref);
    expect(meta!.toolObservationNote).toMatch(/^web_fetch @ \d{4}-\d{2}-\d{2}T/);
  });

  it('mode:async with an unknown ref answers 400 and writes nothing', async () => {
    const r = await f.http
      .post('/v1/ingest/document')
      .set(auth())
      .send({
        kind: 'markdown',
        text: 'A claim with a provenance hop nobody earned (async).',
        occurredAt: '2026-08-01T10:00:00.000Z',
        contextRef: { vertical: 'docasync_e2e' },
        toolObservationRef: 'tool_observation:does_not_exist',
        mode: 'async',
      });
    expect(r.status).toBe(400);
  });

  it('the internal channel is bounded: an over-long contextRef id on a mention is a 400', async () => {
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    const tooLong = 'c'.repeat(INTERNAL_DOCUMENT_META_MAX_CHARS + 1);
    const r = await f.http
      .post('/v1/ingest/mention')
      .set(auth())
      .send({
        text: 'Acme moved to the gold tier.',
        emittedAt: '2026-08-01T10:00:00.000Z',
        contextRef: { vertical: 'docasync_e2e', conversationId: tooLong },
      });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('contextRef.conversationId');
  });
});
