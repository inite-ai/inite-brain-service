import { BadRequestException } from '@nestjs/common';
import { IngestService } from '../src/ingest/ingest.service';
import { MentionViaDocumentService } from '../src/documents/mention-via-document.service';
import type { DocumentIngestService } from '../src/documents/document-ingest.service';
import type { FactIngestService } from '../src/ingest/fact-ingest.service';
import type { MentionIngestService } from '../src/ingest/mention-ingest.service';
import type { LinkIngestService } from '../src/ingest/link-ingest.service';
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import { runWithRequestContext } from '../src/common/request-context';

/**
 * A mention's caller meta is gated once, at IngestService.ingestMention,
 * for both paths, and then rides to where each path keeps provenance: the
 * stored document's caller `meta` (via-document) or the extracted facts'
 * `source.meta` (direct).
 */
describe('mention meta', () => {
  // Production turns fail-closed capture on; these cases have no episode store.
  beforeEach(() => {
    process.env.EVIDENCE_FAIL_CLOSED_CAPTURE ??= '0';
  });
  const saved = process.env.SOURCE_META_STRICT;
  const savedVia = process.env.INGEST_MENTION_VIA_DOCUMENT;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOURCE_META_STRICT;
    else process.env.SOURCE_META_STRICT = saved;
    if (savedVia === undefined) delete process.env.INGEST_MENTION_VIA_DOCUMENT;
    else process.env.INGEST_MENTION_VIA_DOCUMENT = savedVia;
  });

  const dto = (meta?: Record<string, unknown>): IngestMentionDto =>
    ({
      text: 'Maria moved to Lisbon',
      contextRef: { vertical: 'chat' },
      emittedAt: '2026-11-14T10:00:00.000Z',
      ...(meta ? { meta } : {}),
    }) as unknown as IngestMentionDto;

  function facade() {
    const direct = { ingestMention: jest.fn(async () => ({ skipped: true })) };
    const svc = new IngestService(
      {} as FactIngestService,
      direct as unknown as MentionIngestService,
      {} as LinkIngestService,
    );
    return { svc, direct };
  }

  it('refuses a camelCase key before either path runs (strict by default)', async () => {
    delete process.env.SOURCE_META_STRICT;
    const { svc, direct } = facade();
    let err: unknown;
    try {
      await svc.ingestMention('co_x', dto({ conversationId: 'c1' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ code: 'invalid_meta' });
    expect(direct.ingestMention).not.toHaveBeenCalled();
  });

  it('passes the clean remainder on in lax mode', async () => {
    process.env.SOURCE_META_STRICT = '0';
    const { svc, direct } = facade();
    await svc.ingestMention('co_x', dto({ conversationId: 'c1', channel: 'web' }));
    expect(direct.ingestMention).toHaveBeenCalledWith(
      'co_x',
      expect.objectContaining({ meta: { channel: 'web' } }),
    );
  });

  it('hands the inbox context to the document as caller meta', async () => {
    const calls: IngestDocumentDto[] = [];
    const documents = {
      ingestDocument: async (_co: string, d: IngestDocumentDto) => {
        calls.push(d);
        return {
          documentId: 'source_document:d1',
          deduplicated: false,
          mode: 'background',
          committed: { entityIds: [], factIds: [], edgeIds: [] },
        };
      },
    } as unknown as DocumentIngestService;
    const svc = new MentionViaDocumentService(documents);
    const meta = { conversation_id: 'c1', channel: 'whatsapp', direction: 'outbound' };
    await runWithRequestContext({ correlationId: 'mm1' }, () => svc.ingest('co_x', dto(meta)));
    await runWithRequestContext({ correlationId: 'mm2' }, () => svc.ingest('co_x', dto()));
    expect(calls[0]!.meta).toEqual(meta);
    expect(Object.prototype.hasOwnProperty.call(calls[1]!, 'meta')).toBe(false);
  });
});
