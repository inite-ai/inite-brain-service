/**
 * The broker side of the evidence → document bridge
 * (EVIDENCE_DOCUMENT_BRIDGE): after a dispatch, one
 * `evidence_document_bridge` job per asset-level `text` run on a
 * `document` asset — succeeded AND replayed (the sweep is the backfill),
 * never for other capabilities, other modalities, failed runs, or with
 * the flag off. A queue failure is logged, never fails the dispatch.
 */
import {
  declaredModalitySection,
  modalitiesChecksum,
  type DomainPackManifest,
} from '../src/ai/domain-packs';
import type { SurrealService } from '../src/db/surreal.service';
import type { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { EvidenceProcessorBrokerService } from '../src/evidence/processor-broker.service';
import type { ProcessorAdapter } from '../src/evidence/processing/processor-adapter';
import { ProcessingRunService } from '../src/evidence/processing/processing-run.service';
import type { JobClaimService } from '../src/jobs/job-claim.service';

const manifest = (memoryModel: Record<string, unknown>): DomainPackManifest =>
  ({
    id: 'doc_pack',
    version: '1.0.0',
    description: 'Synthetic document pack (unit).',
    predicates: [],
    memoryModel,
  }) as unknown as DomainPackManifest;

const PACK = manifest({
  modalities: ['document', 'image'],
  processors: [
    { id: 'doc_text', modality: 'document', produces: ['text'] },
    { id: 'img_cap', modality: 'image', produces: ['caption'] },
  ],
});
const CHECKSUM = modalitiesChecksum(declaredModalitySection(PACK));

const textAdapter = (over: Partial<ProcessorAdapter> = {}): ProcessorAdapter => ({
  capability: 'text',
  version: 'stub-v1',
  configParts: () => [],
  accepts: (modality) => modality === 'document',
  process: () => Promise.resolve([{ kind: 'text', content: 'extracted' }]),
  ...over,
});
const captionAdapter = (): ProcessorAdapter => ({
  capability: 'caption',
  version: 'stub-v1',
  configParts: () => [],
  accepts: (modality) => modality === 'image',
  process: () => Promise.resolve([{ kind: 'caption', content: 'a cat' }]),
});

function fixture(opts: {
  adapters: ProcessorAdapter[];
  modality?: 'document' | 'image';
  /** An existing succeeded run row ⇒ the dispatch replays. */
  replay?: boolean;
  enqueue?: jest.Mock;
}) {
  const modality = opts.modality ?? 'document';
  const assetRow = {
    id: `evidence_asset:a1`,
    modality,
    mediaType: modality === 'document' ? 'application/pdf' : 'image/png',
    availability: 'hot',
    byteLength: 10,
    storageRef: 'fs://co_x/abc',
  };
  const packRow = {
    manifest: PACK,
    acceptedModalities: true,
    acceptedModalitiesChecksum: CHECKSUM,
  };
  const db = {
    query: jest.fn((sql: string, vars?: Record<string, unknown>) => {
      if (sql.includes("type::record('evidence_asset'")) return Promise.resolve([[assetRow]]);
      if (sql.includes('FROM domain_pack')) return Promise.resolve([[packRow]]);
      if (sql.includes('INSERT IGNORE INTO processing_run')) {
        // A replay: the claim collides (no row returned) and the run
        // service re-reads the recorded outputs.
        if (opts.replay) return Promise.resolve([[]]);
        return Promise.resolve([[{ id: (vars?.row as { id: unknown }).id }]]);
      }
      if (sql.includes("type::record('processing_run'")) {
        return Promise.resolve([
          [{ status: 'succeeded', outputs: ['derived_representation:r_old'] }],
        ]);
      }
      return Promise.resolve([[]]);
    }),
  };
  const surreal = {
    withCompany: jest.fn((_c: string, fn: (d: typeof db) => unknown) => fn(db)),
  } as unknown as SurrealService;
  const store = {
    addRepresentation: jest.fn(() =>
      Promise.resolve({ representationId: 'derived_representation:r1' }),
    ),
  } as unknown as EvidenceStoreService;
  const runs = new ProcessingRunService(surreal, store, new Map());
  const enqueue = opts.enqueue ?? jest.fn(async () => ({ runId: 'j', created: true }));
  const claim = { enqueue } as unknown as JobClaimService;
  const broker = new EvidenceProcessorBrokerService(surreal, opts.adapters, runs, claim);
  return { broker, enqueue };
}

describe('EvidenceProcessorBrokerService — evidence → document bridge enqueue', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [
      'EVIDENCE_PROCESSOR_BROKER',
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_DOCUMENT_BRIDGE',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.EVIDENCE_PROCESSOR_BROKER = '1';
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
    process.env.EVIDENCE_DOCUMENT_BRIDGE = '1';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('enqueues one bridge job per text representation of a document asset', async () => {
    const f = fixture({ adapters: [textAdapter()] });
    const r = await f.broker.dispatchForPack('co_x', {
      packId: 'doc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(r.runs.map((x) => x.status)).toEqual(['succeeded']);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledWith({
      jobType: 'evidence_document_bridge',
      companyId: 'co_x',
      triggeredBy: 'manual',
      dedupKey: 'evbridge_a1_r1',
      payload: {
        assetId: 'evidence_asset:a1',
        representationId: 'derived_representation:r1',
        packId: 'doc_pack',
      },
    });
  });

  it('a replayed run enqueues too — the operator sweep is the backfill', async () => {
    const f = fixture({ adapters: [textAdapter()], replay: true });
    const r = await f.broker.dispatchForPack('co_x', {
      packId: 'doc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(r.runs.map((x) => x.status)).toEqual(['replayed']);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls[0]![0]).toMatchObject({
      dedupKey: 'evbridge_a1_r_old',
      payload: { representationId: 'derived_representation:r_old' },
    });
  });

  it('flag off ⇒ the runs happen, nothing is enqueued', async () => {
    delete process.env.EVIDENCE_DOCUMENT_BRIDGE;
    const f = fixture({ adapters: [textAdapter()] });
    const r = await f.broker.dispatchForPack('co_x', {
      packId: 'doc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(r.runs.map((x) => x.status)).toEqual(['succeeded']);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('an image caption run never bridges', async () => {
    const f = fixture({ adapters: [captionAdapter()], modality: 'image' });
    const r = await f.broker.dispatchForPack('co_x', {
      packId: 'doc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(r.runs.map((x) => x.status)).toEqual(['succeeded']);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('a failed run never bridges', async () => {
    const f = fixture({
      adapters: [textAdapter({ process: () => Promise.reject(new Error('pdf broken')) })],
    });
    const r = await f.broker.dispatchForPack('co_x', {
      packId: 'doc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(r.runs.map((x) => x.status)).toEqual(['failed']);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('a queue failure is logged, the dispatch still succeeds', async () => {
    const enqueue = jest.fn(async () => {
      throw new Error('queue down');
    });
    const f = fixture({ adapters: [textAdapter()], enqueue });
    const r = await f.broker.dispatchForPack('co_x', {
      packId: 'doc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(r.outcome.succeeded).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
