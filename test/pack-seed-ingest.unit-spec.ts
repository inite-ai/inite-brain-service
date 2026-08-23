/**
 * PackSeedIngestService.runForPack — DTO shaping, count bookkeeping,
 * poison-document isolation, and the clean skips (pack missing / version
 * superseded / no seeds). The DocumentIngestService is stubbed; what's
 * under test is the seam between an installed manifest's seedDocuments
 * and the normal document-pipeline entry.
 */
import { PackSeedIngestService } from '../src/documents/pack-seed-ingest.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { DocumentIngestService } from '../src/documents/document-ingest.service';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import type { PackSeedDocument } from '../src/ai/domain-packs';

function surrealWithRow(row: unknown): SurrealService {
  return {
    withCompany: (_companyId: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({ query: async () => [row === undefined ? [] : [row]] }),
  } as unknown as SurrealService;
}

function packRow(seeds: PackSeedDocument[] | undefined, version = '1.0.0') {
  return {
    version,
    manifest: {
      id: 'gardening',
      version,
      description: 'x',
      predicates: [],
      ...(seeds ? { seedDocuments: seeds } : {}),
    },
  };
}

function seed(over: Partial<PackSeedDocument> = {}): PackSeedDocument {
  return {
    localId: 'primer',
    title: 'Gardening primer',
    text: 'Tomatoes want sun.',
    vertical: 'garden',
    ...over,
  };
}

interface IngestStub {
  svc: DocumentIngestService;
  calls: IngestDocumentDto[];
}

function ingestStub(
  behavior?: (dto: IngestDocumentDto, call: number) => { deduplicated: boolean },
): IngestStub {
  const calls: IngestDocumentDto[] = [];
  const svc = {
    ingestDocument: async (_companyId: string, dto: IngestDocumentDto) => {
      calls.push(dto);
      return {
        documentId: `source_document:d${calls.length}`,
        ...(behavior ? behavior(dto, calls.length) : { deduplicated: false }),
      };
    },
  } as unknown as DocumentIngestService;
  return { svc, calls };
}

const REF = { packId: 'gardening', packVersion: '1.0.0' };

describe('PackSeedIngestService.runForPack', () => {
  it('ingests every seed and reports counts (dedup split out)', async () => {
    const ingest = ingestStub((_dto, call) => ({ deduplicated: call === 2 }));
    const svc = new PackSeedIngestService(
      surrealWithRow(packRow([seed(), seed({ localId: 'glossary' }), seed({ localId: 'faq' })])),
      ingest.svc,
    );
    const r = await svc.runForPack('co_1', REF);
    expect(r).toEqual({ total: 3, ingested: 2, deduplicated: 1, failed: 0 });
    expect(ingest.calls).toHaveLength(3);
  });

  it('isolates a poison document — counts it failed and continues', async () => {
    const ingest = ingestStub((_dto, call) => {
      if (call === 2) throw new Error('boom');
      return { deduplicated: false };
    });
    const svc = new PackSeedIngestService(
      surrealWithRow(packRow([seed(), seed({ localId: 'poison' }), seed({ localId: 'faq' })])),
      ingest.svc,
    );
    const r = await svc.runForPack('co_1', REF);
    expect(r).toEqual({ total: 3, ingested: 2, deduplicated: 0, failed: 1 });
  });

  it('skips cleanly when the pack is not installed', async () => {
    const ingest = ingestStub();
    const svc = new PackSeedIngestService(surrealWithRow(undefined), ingest.svc);
    const r = await svc.runForPack('co_1', REF);
    expect(r).toEqual({ total: 0, ingested: 0, deduplicated: 0, failed: 0 });
    expect(ingest.calls).toHaveLength(0);
  });

  it('skips cleanly when a newer install superseded the queued version', async () => {
    const ingest = ingestStub();
    const svc = new PackSeedIngestService(surrealWithRow(packRow([seed()], '2.0.0')), ingest.svc);
    const r = await svc.runForPack('co_1', REF);
    expect(r.total).toBe(0);
    expect(ingest.calls).toHaveLength(0);
  });

  it('skips cleanly when the manifest ships no seedDocuments', async () => {
    const ingest = ingestStub();
    const svc = new PackSeedIngestService(surrealWithRow(packRow(undefined)), ingest.svc);
    const r = await svc.runForPack('co_1', REF);
    expect(r.total).toBe(0);
    expect(ingest.calls).toHaveLength(0);
  });

  it('shapes the DTO for the normal pipeline (defaults applied)', async () => {
    const before = Date.now();
    const ingest = ingestStub();
    const svc = new PackSeedIngestService(
      surrealWithRow(packRow([seed({ meta: { audience: 'agents' } })])),
      ingest.svc,
    );
    await svc.runForPack('co_1', REF);
    const dto = ingest.calls[0]!;
    expect(dto.kind).toBe('pack_seed');
    expect(dto.title).toBe('Gardening primer');
    expect(dto.text).toBe('Tomatoes want sun.');
    expect(dto.originUri).toBe('pack://gardening/primer');
    expect(dto.contextRef).toEqual({
      vertical: 'garden',
      recorder: 'pack:gardening',
    });
    // Flat scalar provenance keys, author meta preserved.
    expect(dto.meta).toEqual({
      audience: 'agents',
      pack_seed: true,
      pack_id: 'gardening',
      pack_version: '1.0.0',
      pack_seed_doc: 'primer',
    });
    expect(dto.storeContent).toBe(true);
    expect(dto.mode).toBe('sync');
    expect(dto.indexers).toEqual(['gardening']);
    // occurredAt defaults to ingest time (valid ISO, roughly now).
    const at = Date.parse(dto.occurredAt);
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('passes explicit originUri and occurredAt through verbatim', async () => {
    const ingest = ingestStub();
    const svc = new PackSeedIngestService(
      surrealWithRow(
        packRow([
          seed({
            originUri: 'https://example.com/primer',
            occurredAt: '2026-01-01T00:00:00.000Z',
          }),
        ]),
      ),
      ingest.svc,
    );
    await svc.runForPack('co_1', REF);
    expect(ingest.calls[0]!.originUri).toBe('https://example.com/primer');
    expect(ingest.calls[0]!.occurredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws "aborted" between documents so the job requeues', async () => {
    const controller = new AbortController();
    const ingest = ingestStub(() => {
      controller.abort();
      return { deduplicated: false };
    });
    const svc = new PackSeedIngestService(
      surrealWithRow(packRow([seed(), seed({ localId: 'glossary' })])),
      ingest.svc,
    );
    await expect(svc.runForPack('co_1', REF, controller.signal)).rejects.toThrow('aborted');
    expect(ingest.calls).toHaveLength(1);
  });
});
