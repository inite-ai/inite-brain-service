/**
 * Evidence processing sweep terminal status
 * (src/evidence/processor-broker.service.ts): a processing run that
 * recorded `failed` used to count its asset as `dispatched` and vanish
 * into a warning. Now the asset is a failed unit of the sweep's outcome,
 * the run's persisted error rides along, and `assetIds` (the retry
 * selector) re-dispatches exactly those assets without the candidate read.
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

const PACK = {
  id: 'proc_pack',
  version: '1.0.0',
  description: 'Synthetic processor pack (unit).',
  predicates: [],
  memoryModel: {
    modalities: ['image'],
    processors: [{ id: 'img_cap', modality: 'image', produces: ['caption'] }],
  },
} as unknown as DomainPackManifest;
const CHECKSUM = modalitiesChecksum(declaredModalitySection(PACK));

const adapterOf = (process: ProcessorAdapter['process']): ProcessorAdapter => ({
  capability: 'caption',
  version: 'stub-v1',
  configParts: () => [],
  accepts: () => true,
  process,
});

function fixture(opts: { adapter: ProcessorAdapter; assets: string[] }) {
  const queries: string[] = [];
  const db = {
    query: jest.fn((sql: string, vars?: Record<string, unknown>) => {
      queries.push(sql);
      if (sql.includes("type::record('evidence_asset'")) {
        const known = opts.assets.find((id) => id.endsWith(`:${String(vars?.tail)}`));
        if (!known) return Promise.resolve([[]]);
        return Promise.resolve([
          [{ id: known, modality: 'image', mediaType: 'image/png', availability: 'external' }],
        ]);
      }
      if (sql.includes('FROM domain_pack')) {
        return Promise.resolve([
          [{ manifest: PACK, acceptedModalities: true, acceptedModalitiesChecksum: CHECKSUM }],
        ]);
      }
      if (sql.includes('INSERT IGNORE INTO processing_run')) {
        return Promise.resolve([[{ id: (vars?.row as { id: unknown }).id }]]);
      }
      if (sql.includes('SELECT VALUE id FROM evidence_asset')) {
        return Promise.resolve([opts.assets]);
      }
      return Promise.resolve([[]]);
    }),
  };
  const surreal = {
    withCompany: (_c: string, fn: (d: typeof db) => unknown) => fn(db),
  } as unknown as SurrealService;
  const store = {
    addRepresentation: jest.fn(() =>
      Promise.resolve({ representationId: 'derived_representation:r1' }),
    ),
  } as unknown as EvidenceStoreService;
  const runs = new ProcessingRunService(surreal, store, new Map());
  const broker = new EvidenceProcessorBrokerService(surreal, [opts.adapter], runs);
  return { broker, queries };
}

describe('EvidenceProcessorBrokerService — sweep terminal status', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['EVIDENCE_PROCESSOR_BROKER', 'EVIDENCE_SUBSTRATE_ENABLED']) {
      saved[k] = process.env[k];
      process.env[k] = '1';
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a clean sweep is complete, one unit per asset', async () => {
    const f = fixture({
      adapter: adapterOf(() => Promise.resolve([{ kind: 'caption', content: 'ok' }])),
      assets: ['evidence_asset:a1', 'evidence_asset:a2'],
    });
    const res = await f.broker.dispatchSweep('co_x', { packId: 'proc_pack' });
    expect(res).toMatchObject({ assets: 2, dispatched: 2, runs: 2, failed: 0 });
    expect(res.outcome).toEqual({
      status: 'complete',
      total: 2,
      succeeded: 2,
      failed: [],
      degradedBy: [],
    });
  });

  it('a run that recorded `failed` fails its asset — every asset ⇒ failed sweep', async () => {
    const f = fixture({
      adapter: adapterOf(() => Promise.reject(new Error('ocr engine crashed'))),
      assets: ['evidence_asset:a1', 'evidence_asset:a2'],
    });
    const res = await f.broker.dispatchSweep('co_x', { packId: 'proc_pack' });
    // The legacy counters still say "dispatched without throwing"…
    expect(res).toMatchObject({ dispatched: 2, runs: 2, failed: 0 });
    // …the outcome says what actually happened.
    expect(res.outcome.status).toBe('failed');
    expect(res.outcome.failed).toEqual([
      { key: 'evidence_asset:a1', error: 'caption: ocr engine crashed' },
      { key: 'evidence_asset:a2', error: 'caption: ocr engine crashed' },
    ]);
  });

  it('a single-asset dispatch carries its own outcome keyed by capability', async () => {
    const f = fixture({
      adapter: adapterOf(() => Promise.reject(new Error('boom'))),
      assets: ['evidence_asset:a1'],
    });
    const res = await f.broker.dispatchForPack('co_x', {
      packId: 'proc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(res.runs[0]).toMatchObject({ status: 'failed', error: 'boom' });
    expect(res.outcome).toMatchObject({ status: 'failed', total: 1, succeeded: 0 });
    expect(res.outcome.failed).toEqual([{ key: 'caption', error: 'boom' }]);
  });

  it('an asset whose dispatch throws is a failed unit too; the sweep is degraded', async () => {
    const f = fixture({
      adapter: adapterOf(() => Promise.resolve([{ kind: 'caption', content: 'ok' }])),
      assets: ['evidence_asset:a1'],
    });
    const res = await f.broker.dispatchSweep('co_x', {
      packId: 'proc_pack',
      assetIds: ['evidence_asset:a1', 'evidence_asset:missing'],
    });
    expect(res).toMatchObject({ assets: 2, dispatched: 1, failed: 1 });
    expect(res.outcome.status).toBe('degraded');
    expect(res.outcome.failed).toEqual([
      { key: 'evidence_asset:missing', error: 'asset evidence_asset:missing not found' },
    ]);
  });

  it('retry with assetIds dispatches exactly those and never reads candidates', async () => {
    const f = fixture({
      adapter: adapterOf(() => Promise.resolve([{ kind: 'caption', content: 'ok' }])),
      assets: ['evidence_asset:a1', 'evidence_asset:a2', 'evidence_asset:a3'],
    });
    const res = await f.broker.dispatchSweep('co_x', {
      packId: 'proc_pack',
      assetIds: ['evidence_asset:a2'],
    });
    expect(f.queries.some((q) => q.includes('SELECT VALUE id FROM evidence_asset'))).toBe(false);
    expect(res).toMatchObject({ assets: 1, dispatched: 1 });
    expect(res.outcome).toMatchObject({ status: 'complete', total: 1, succeeded: 1 });
  });
});
