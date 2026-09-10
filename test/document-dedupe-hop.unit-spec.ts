/**
 * A dedupe hit must not swallow the provenance the request carried
 * (audit 2026-09-09).
 *
 * Re-posting byte-identical text returns the EXISTING header row, so a
 * freshly verified `toolObservationRef` had nowhere to land: the commit
 * writer reads the 0111 hop off the header, so every fact committed
 * afterwards lacked it and the log said only "dedupe hit". The hop is
 * merged onto a header that has none; a header that already carries one
 * keeps it, and the origin identifiers (which name the header's first
 * turn) are reported at warn with the document id — never written, never
 * dropped in silence.
 */
import { Logger } from '@nestjs/common';
import { DocumentStoreService } from '../src/documents/document-store.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import type { InternalDocumentMeta } from '../src/documents/document-meta';

const TEXT = 'Fetched report: Acme is platinum tier.';

const dto = (): IngestDocumentDto =>
  ({
    kind: 'markdown',
    text: TEXT,
    occurredAt: '2026-09-01T10:00:00.000Z',
    contextRef: { vertical: 'crm' },
  }) as IngestDocumentDto;

interface Issued {
  sql: string;
  params: Record<string, unknown> | undefined;
}

/** A store whose CREATE always collides, so every call is a dedupe hit. */
function fixture(storedMeta?: Record<string, unknown>) {
  const issued: Issued[] = [];
  const existing: Record<string, unknown> = {
    id: 'source_document:d1',
    kind: 'markdown',
    contentHash: 'a'.repeat(64),
    charLen: TEXT.length,
    chunkCount: 1,
    hasContent: true,
    vertical: 'crm',
    occurredAt: '2026-09-01T10:00:00.000Z',
    status: 'received',
    ...(storedMeta ? { meta: storedMeta } : {}),
  };
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      issued.push({ sql, params });
      if (sql.includes('CREATE type::table($t)')) {
        throw new Error(
          'Database index `source_document_hash_idx` already contains a record with id',
        );
      }
      if (sql.includes('FROM source_document WHERE contentHash')) return [[existing]];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: typeof db) => Promise<T>) => fn(db),
  } as unknown as SurrealService;
  return { store: new DocumentStoreService(surreal), issued, existing };
}

const post = (store: DocumentStoreService, internal: InternalDocumentMeta | undefined) =>
  store.createOrGet('co_x', dto(), { channel: 'ingest_sync', internal });

const metaUpdate = (issued: Issued[]) =>
  issued.find((q) => q.sql.includes("UPDATE type::record('source_document', $id) SET meta"));

describe('a dedupe hit and the 0111 tool-observation hop', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('merges the verified hop onto a header that carries none', async () => {
    const f = fixture();
    const res = await post(f.store, {
      toolObservationRef: 'tool_observation:abc',
      toolObservationNote: 'web_fetch @ 2026-09-01T09:59:00.000Z',
    });
    expect(res.deduplicated).toBe(true);
    const update = metaUpdate(f.issued);
    expect(update).toBeDefined();
    expect(update!.params?.meta).toEqual({
      toolObservationRef: 'tool_observation:abc',
      toolObservationNote: 'web_fetch @ 2026-09-01T09:59:00.000Z',
    });
    // The caller gets the header it will commit facts against.
    expect(res.doc.meta).toMatchObject({ toolObservationRef: 'tool_observation:abc' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the hop a header already carries, and says which keys were dropped', async () => {
    const f = fixture({ toolObservationRef: 'tool_observation:first' });
    const res = await post(f.store, {
      toolObservationRef: 'tool_observation:second',
      toolObservationNote: 'web_fetch @ 2026-09-01T09:59:00.000Z',
    });
    expect(metaUpdate(f.issued)).toBeUndefined();
    expect(res.doc.meta).toEqual({ toolObservationRef: 'tool_observation:first' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('source_document:d1');
    expect(line).toContain('toolObservationRef');
  });

  it('origin identifiers are reported, never rewritten onto the stored header', async () => {
    const f = fixture({ conversationId: 'conv:first' });
    await post(f.store, { conversationId: 'conv:second' });
    expect(metaUpdate(f.issued)).toBeUndefined();
    expect(String(warn.mock.calls[0]![0])).toContain('conversationId');
  });

  it('a request carrying no internal bag writes nothing and warns nothing', async () => {
    const f = fixture({ toolObservationRef: 'tool_observation:first' });
    const res = await post(f.store, undefined);
    expect(metaUpdate(f.issued)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(res.doc.id).toBe('source_document:d1');
  });
});
