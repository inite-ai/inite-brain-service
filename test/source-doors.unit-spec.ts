/**
 * SourceDoorsService — "shape decides the door": each fetched shape
 * lands in the existing ingest path for that shape, with the
 * connection's provenance (vertical / recorder / owner), the item's
 * originUri (or the brain-owned fallback), the source's clock, and the
 * source-plane header keys the commit writer folds into
 * source.sourceVersion. renderRecord is deterministic.
 */
import type { DocumentIngestService } from '../src/documents/document-ingest.service';
import type { DocumentIngestOrigin } from '../src/documents/document-meta';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import type { EvidenceUploadService } from '../src/evidence/evidence-upload.service';
import type { IngestService } from '../src/ingest/ingest.service';
import type { ConnectorConnectionView } from '../src/source-plane/connector';
import { SourceDoorsService, originUriOf, renderRecord } from '../src/source-plane/source-doors.service';

const connection: ConnectorConnectionView = {
  id: 'source_connection:c1',
  packId: 'wiki_pack',
  sourceId: 'wiki',
  kind: 'native',
  connector: 'memory',
  shape: 'document',
  host: 'server',
  config: {},
  credential: null,
  contentPolicy: 'text',
  vertical: 'wiki',
  recorder: 'srcconn_c1',
  userId: 'u_9',
};

const stamp = { system: 'memory', ref: 'page-1', version: 'r7', readAt: '2026-09-16T10:00:00.000Z' };

function doors() {
  const docCalls: Array<{ dto: IngestDocumentDto; origin: DocumentIngestOrigin }> = [];
  const uploads: unknown[] = [];
  const mentions: unknown[] = [];
  const svc = new SourceDoorsService(
    {
      ingestDocument: async (_c: string, dto: IngestDocumentDto, origin: DocumentIngestOrigin) => {
        docCalls.push({ dto, origin });
        return { documentId: 'source_document:d1', deduplicated: false };
      },
    } as unknown as DocumentIngestService,
    {
      upload: async (_c: string, blob: unknown, input: unknown) => {
        uploads.push({ blob, input });
        return { assetId: 'evidence_asset:a1', byteHash: 'h', deduped: true };
      },
    } as unknown as EvidenceUploadService,
    {
      ingestMention: async (_c: string, dto: unknown) => {
        mentions.push(dto);
        return { skipped: false, episodeId: 'episode:e1' };
      },
    } as unknown as IngestService,
  );
  return { svc, docCalls, uploads, mentions };
}

describe('SourceDoorsService', () => {
  it('document → ingest/document with provenance, header keys and the version stamp', async () => {
    const d = doors();
    const out = await d.svc.ingest({
      companyId: 'co',
      connection,
      itemId: 'source_item:i1',
      item: { externalId: 'page-1', originUri: 'https://wiki.example/page-1', title: 'Onboarding', modifiedAt: '2026-09-01T00:00:00.000Z' },
      fetched: { shape: 'document', text: 'Welcome to the team.' },
      stamp,
    });
    expect(out).toEqual({ documentId: 'source_document:d1', deduplicated: false });
    const { dto, origin } = d.docCalls[0]!;
    expect(dto).toEqual({
      kind: 'source_document',
      text: 'Welcome to the team.',
      originUri: 'https://wiki.example/page-1',
      title: 'Onboarding',
      occurredAt: '2026-09-01T00:00:00.000Z',
      userId: 'u_9',
      contextRef: { vertical: 'wiki', recorder: 'srcconn_c1' },
      meta: { source_connection: 'c1', source_pack: 'wiki_pack', source_id: 'wiki' },
      storeContent: true,
      mode: 'sync',
      indexers: ['wiki_pack'],
    });
    expect(origin).toEqual({
      channel: 'source',
      internal: {
        sourceConnectionId: 'source_connection:c1',
        sourceItemId: 'source_item:i1',
        sourceVersionSystem: 'memory',
        sourceVersionRef: 'page-1',
        sourceVersionValue: 'r7',
        sourceVersionReadAt: '2026-09-16T10:00:00.000Z',
      },
    });
  });

  it('falls back to a brain-owned originUri and omits the stamp keys without a revision', async () => {
    const d = doors();
    await d.svc.ingest({
      companyId: 'co',
      connection: { ...connection, userId: null },
      itemId: 'source_item:i1',
      item: { externalId: 'notes/a b.md' },
      fetched: { shape: 'document', text: 'x', kind: 'note' },
      stamp: null,
    });
    const { dto, origin } = d.docCalls[0]!;
    expect(dto.originUri).toBe('source://c1/notes%2Fa%20b.md');
    expect(dto.kind).toBe('note');
    expect('userId' in dto).toBe(false);
    expect(origin).toEqual({
      channel: 'source',
      internal: { sourceConnectionId: 'source_connection:c1', sourceItemId: 'source_item:i1' },
    });
    expect(originUriOf(connection, { externalId: 'x', originUri: 'https://e/x' })).toBe('https://e/x');
  });

  it('structure → a deterministic record document (kind source_record, record_type in meta)', async () => {
    const d = doors();
    const record = {
      entityType: 'contact',
      externalId: '42',
      name: 'Ada Lovelace',
      attributes: { email: 'ada@example.com', stage: 'lead', b: 1, a: true, skip: null },
      relations: [{ kind: 'works_at', targetType: 'company', targetExternalId: '7', targetName: 'Analytical Engines' }],
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    await d.svc.ingest({
      companyId: 'co',
      connection,
      itemId: 'source_item:i2',
      item: { externalId: '42' },
      fetched: { shape: 'structure', record },
      stamp: null,
    });
    const { dto } = d.docCalls[0]!;
    expect(dto.kind).toBe('source_record');
    expect(dto.title).toBe('Ada Lovelace');
    expect(dto.occurredAt).toBe('2026-09-10T00:00:00.000Z');
    expect(dto.meta).toMatchObject({ record_type: 'contact' });
    expect(dto.text).toBe(
      ['contact: Ada Lovelace', 'id: 42', 'a: true', 'b: 1', 'email: ada@example.com', 'stage: lead', 'works_at: company Analytical Engines', 'updated_at: 2026-09-10T00:00:00.000Z'].join('\n'),
    );
    expect(renderRecord(record)).toBe(renderRecord({ ...record, attributes: { stage: 'lead', a: true, b: 1, email: 'ada@example.com' } }));
  });

  it('binary → evidence upload with the connection as recorder and the pack for dispatch', async () => {
    const d = doors();
    const out = await d.svc.ingest({
      companyId: 'co',
      connection,
      itemId: 'source_item:i3',
      item: { externalId: 'scan.pdf', title: 'scan.pdf', modifiedAt: '2026-09-02T00:00:00.000Z' },
      fetched: { shape: 'binary', bytes: Buffer.from('%PDF'), mediaType: 'application/pdf', modality: 'document' },
      stamp: null,
    });
    expect(out).toEqual({ assetId: 'evidence_asset:a1', byteHash: 'h', deduplicated: true });
    expect(d.uploads[0]).toMatchObject({
      blob: { originalname: 'scan.pdf', mimetype: 'application/pdf', size: 4 },
      input: {
        modality: 'document',
        mediaType: 'application/pdf',
        occurredAt: new Date('2026-09-02T00:00:00.000Z'),
        vertical: 'wiki',
        userId: 'u_9',
        recorder: 'srcconn_c1',
        packId: 'wiki_pack',
      },
    });
  });

  it('conversation → one mention per turn with conversation/message ids and the speaker prefixed', async () => {
    const d = doors();
    const out = await d.svc.ingest({
      companyId: 'co',
      connection,
      itemId: 'source_item:i4',
      item: { externalId: 'thread-1' },
      fetched: {
        shape: 'conversation',
        conversationId: 'thread-1',
        turns: [
          { speaker: 'ann', text: 'shipping friday', at: '2026-09-03T09:00:00.000Z', messageId: 'm1' },
          { text: 'ok', at: '2026-09-03T09:01:00.000Z' },
        ],
      },
      stamp: null,
    });
    expect(out).toEqual({ episodeId: 'episode:e1', deduplicated: false });
    expect(d.mentions).toEqual([
      {
        text: 'ann: shipping friday',
        contextRef: { vertical: 'wiki', conversationId: 'thread-1', messageId: 'm1', recorder: 'srcconn_c1' },
        userId: 'u_9',
        emittedAt: '2026-09-03T09:00:00.000Z',
      },
      {
        text: 'ok',
        contextRef: { vertical: 'wiki', conversationId: 'thread-1', messageId: 'thread-1#1', recorder: 'srcconn_c1' },
        userId: 'u_9',
        emittedAt: '2026-09-03T09:01:00.000Z',
      },
    ]);
  });
});
