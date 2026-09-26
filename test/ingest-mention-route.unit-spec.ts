/**
 * IngestService decides the mention path for every caller alike — the
 * HTTP route, the source doors' conversation turns, the demo: under
 * INGEST_MENTION_VIA_DOCUMENT a mention goes through the document
 * pipeline (remembered at once, read in the background), else direct.
 */
import { IngestService } from '../src/ingest/ingest.service';

describe('IngestService.ingestMention route', () => {
  const dto = { text: 'hi', contextRef: { vertical: 'chat' } } as never;
  const make = (withDocuments = true) => {
    const direct = { ingestMention: jest.fn(async () => ({ via: 'direct' })) };
    const viaDocument = { ingest: jest.fn(async () => ({ via: 'document' })) };
    const svc = new IngestService(
      {} as never,
      direct as never,
      {} as never,
      withDocuments ? (viaDocument as never) : undefined,
    );
    return { svc, direct, viaDocument };
  };

  afterEach(() => delete process.env.INGEST_MENTION_VIA_DOCUMENT);

  it('goes through the document pipeline under the flag', async () => {
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    const { svc, direct, viaDocument } = make();
    await expect(svc.ingestMention('co', dto)).resolves.toEqual({ via: 'document' });
    expect(viaDocument.ingest).toHaveBeenCalledWith('co', dto);
    expect(direct.ingestMention).not.toHaveBeenCalled();
  });

  it('goes direct without the flag, or without the pipeline wired', async () => {
    const off = make();
    await expect(off.svc.ingestMention('co', dto)).resolves.toEqual({ via: 'direct' });
    process.env.INGEST_MENTION_VIA_DOCUMENT = '1';
    const unwired = make(false);
    await expect(unwired.svc.ingestMention('co', dto)).resolves.toEqual({ via: 'direct' });
  });
});
