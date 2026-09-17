/**
 * EvidenceDocumentBridgeService — the evidence → document seam
 * (EVIDENCE_DOCUMENT_BRIDGE):
 *  - flag off ⇒ named skip, no ingest, no enqueue;
 *  - the DTO the bridge hands the pipeline: kind, the asset's own
 *    vertical / recorder / occurredAt / userId, originUri fallback,
 *    stored content, the pack as first indexer, the internal hop;
 *  - every clean skip is a named result (row gone, not asset text,
 *    superseded, empty, wrong modality, tombstoned asset);
 *  - over-cap text splits into parts with distinct originUri suffixes;
 *  - a poison part is counted failed and the rest proceed;
 *  - splitForDocuments: paragraph boundaries first, hard cut last.
 */
import {
  EvidenceDocumentBridgeService,
  evidenceBridgeDedupKey,
  splitForDocuments,
} from '../src/documents/evidence-document-bridge.service';
import { EvidenceDocumentBridgeQueueService } from '../src/documents/evidence-document-bridge-queue.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { DocumentIngestService } from '../src/documents/document-ingest.service';
import type { DocumentIngestOrigin } from '../src/documents/document-meta';
import type { IngestDocumentDto } from '../src/documents/dto/ingest-document.dto';
import { DOC_TEXT_HARD_CAP } from '../src/documents/dto/ingest-document.dto';
import type { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import type { JobClaimService } from '../src/jobs/job-claim.service';

const REF = {
  assetId: 'evidence_asset:a1',
  representationId: 'derived_representation:r1',
  packId: 'legal',
};

function surrealWithRepresentation(row: unknown): SurrealService {
  return {
    withCompany: (_companyId: string, fn: (db: unknown) => Promise<unknown>) =>
      fn({ query: async () => [row === undefined ? [] : [row]] }),
  } as unknown as SurrealService;
}

function representation(over: Record<string, unknown> = {}) {
  return { kind: 'text', subjectKind: 'asset', content: 'Clause 4: rent is due monthly.', ...over };
}

function asset(over: Record<string, unknown> = {}) {
  return {
    id: 'evidence_asset:a1',
    modality: 'document',
    availability: 'hot',
    vertical: 'contracts',
    recorder: 'upload_bot',
    occurredAt: new Date('2026-03-01T10:00:00.000Z'),
    userId: 'u_7',
    ...over,
  };
}

function storeWith(row: unknown): EvidenceStoreService {
  return { getAsset: async () => row ?? null } as unknown as EvidenceStoreService;
}

interface IngestStub {
  svc: DocumentIngestService;
  calls: Array<{ dto: IngestDocumentDto; origin: DocumentIngestOrigin }>;
}

function ingestStub(
  behavior?: (dto: IngestDocumentDto, call: number) => { deduplicated: boolean },
): IngestStub {
  const calls: IngestStub['calls'] = [];
  const svc = {
    ingestDocument: async (
      _companyId: string,
      dto: IngestDocumentDto,
      origin: DocumentIngestOrigin,
    ) => {
      calls.push({ dto, origin });
      return {
        documentId: `source_document:d${calls.length}`,
        ...(behavior ? behavior(dto, calls.length) : { deduplicated: false }),
      };
    },
  } as unknown as DocumentIngestService;
  return { svc, calls };
}

function bridgeWith(p: {
  rep?: unknown;
  asset?: unknown;
  ingest?: IngestStub;
  claim?: JobClaimService;
}) {
  const ingest = p.ingest ?? ingestStub();
  const svc = new EvidenceDocumentBridgeService(
    surrealWithRepresentation(p.rep),
    ingest.svc,
    storeWith(p.asset),
  );
  const queue = new EvidenceDocumentBridgeQueueService(svc, undefined, p.claim);
  return { svc, queue, ingest };
}

describe('EvidenceDocumentBridgeService', () => {
  const saved = process.env.EVIDENCE_DOCUMENT_BRIDGE;
  beforeEach(() => {
    process.env.EVIDENCE_DOCUMENT_BRIDGE = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EVIDENCE_DOCUMENT_BRIDGE;
    else process.env.EVIDENCE_DOCUMENT_BRIDGE = saved;
  });

  it('flag off ⇒ named skip, nothing ingested, nothing enqueued', async () => {
    delete process.env.EVIDENCE_DOCUMENT_BRIDGE;
    const enqueue = jest.fn();
    const { svc, queue, ingest } = bridgeWith({
      rep: representation(),
      asset: asset(),
      claim: { enqueue } as unknown as JobClaimService,
    });
    expect(await svc.bridge('co_1', REF)).toEqual({
      parts: 0,
      ingested: 0,
      deduplicated: 0,
      failed: 0,
      skipped: 'flag_off',
    });
    expect(await queue.enqueue('co_1', REF)).toEqual({ enqueued: false });
    expect(ingest.calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('shapes the text as an ordinary document with the asset as provenance', async () => {
    const { svc, ingest } = bridgeWith({ rep: representation(), asset: asset() });
    const r = await svc.bridge('co_1', REF);
    expect(r).toEqual({ parts: 1, ingested: 1, deduplicated: 0, failed: 0 });
    expect(ingest.calls).toHaveLength(1);
    const { dto, origin } = ingest.calls[0]!;
    expect(dto).toEqual({
      kind: 'evidence_text',
      text: 'Clause 4: rent is due monthly.',
      originUri: 'evidence://asset/a1',
      occurredAt: '2026-03-01T10:00:00.000Z',
      userId: 'u_7',
      contextRef: { vertical: 'contracts', recorder: 'upload_bot' },
      meta: { evidence_bridge: true },
      storeContent: true,
      mode: 'sync',
      indexers: ['legal'],
    });
    expect(origin).toEqual({
      channel: 'evidence',
      internal: {
        evidenceAssetId: 'evidence_asset:a1',
        evidenceRepresentationId: 'derived_representation:r1',
      },
    });
  });

  it('keeps the asset originUri when it has one; omits recorder/userId when absent', async () => {
    const { svc, ingest } = bridgeWith({
      rep: representation(),
      asset: asset({ originUri: 'https://dms.example/doc/9', recorder: null, userId: undefined }),
    });
    await svc.bridge('co_1', REF);
    const { dto } = ingest.calls[0]!;
    expect(dto.originUri).toBe('https://dms.example/doc/9');
    expect(dto.contextRef).toEqual({ vertical: 'contracts' });
    expect('userId' in dto).toBe(false);
  });

  it.each([
    ['representation_missing', undefined, asset()],
    ['not_asset_text', representation({ kind: 'caption' }), asset()],
    ['not_asset_text', representation({ subjectKind: 'fragment' }), asset()],
    ['superseded', representation({ supersededBy: 'derived_representation:r2' }), asset()],
    ['empty_text', representation({ content: '   ' }), asset()],
    ['asset_missing', representation(), undefined],
    ['not_document_modality', representation(), asset({ modality: 'image' })],
    ['asset_gone', representation(), asset({ availability: 'gone' })],
  ])('skips cleanly: %s', async (skipped, rep, assetRow) => {
    const { svc, ingest } = bridgeWith({ rep, asset: assetRow });
    const r = await svc.bridge('co_1', REF);
    expect(r).toEqual({ parts: 0, ingested: 0, deduplicated: 0, failed: 0, skipped });
    expect(ingest.calls).toHaveLength(0);
  });

  it('splits over-cap text into parts with distinct originUri suffixes', async () => {
    const paragraph = 'x'.repeat(DOC_TEXT_HARD_CAP - 10);
    const { svc, ingest } = bridgeWith({
      rep: representation({ content: `${paragraph}\n\n${paragraph}` }),
      asset: asset(),
    });
    const r = await svc.bridge('co_1', REF);
    expect(r).toEqual({ parts: 2, ingested: 2, deduplicated: 0, failed: 0 });
    expect(ingest.calls.map((c) => c.dto.originUri)).toEqual([
      'evidence://asset/a1',
      'evidence://asset/a1#part=2',
    ]);
  });

  it('counts dedup separately and isolates a poison part', async () => {
    const paragraph = 'y'.repeat(DOC_TEXT_HARD_CAP - 10);
    const ingest = ingestStub((_dto, call) => {
      if (call === 2) throw new Error('resolver down');
      return { deduplicated: call === 3 };
    });
    const { svc } = bridgeWith({
      rep: representation({ content: [paragraph, paragraph, paragraph].join('\n\n') }),
      asset: asset(),
      ingest,
    });
    const r = await svc.bridge('co_1', REF);
    expect(r).toEqual({ parts: 3, ingested: 1, deduplicated: 1, failed: 1 });
    expect(ingest.calls).toHaveLength(3);
  });

  it('enqueue dedups per (asset, representation) through the claim service', async () => {
    const enqueue = jest.fn(async () => ({ runId: 'r', created: true }));
    const { queue } = bridgeWith({ claim: { enqueue } as unknown as JobClaimService });
    expect(await queue.enqueue('co_1', REF)).toEqual({ enqueued: true });
    expect(enqueue).toHaveBeenCalledWith({
      jobType: 'evidence_document_bridge',
      companyId: 'co_1',
      triggeredBy: 'manual',
      dedupKey: 'evbridge_a1_r1',
      payload: REF,
    });
    expect(evidenceBridgeDedupKey('evidence_asset:a1', 'derived_representation:r1')).toBe(
      'evbridge_a1_r1',
    );
  });
});

describe('splitForDocuments', () => {
  it('returns the text whole under the cap', () => {
    expect(splitForDocuments('a\n\nb', 100)).toEqual(['a\n\nb']);
  });

  it('packs paragraphs up to the cap, breaking at paragraph boundaries', () => {
    const parts = splitForDocuments('aaaa\n\nbbbb\n\ncccc\n\ndddd', 10);
    expect(parts).toEqual(['aaaa\n\nbbbb', 'cccc\n\ndddd']);
  });

  it('hard-cuts a single paragraph longer than the cap', () => {
    expect(splitForDocuments('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});
