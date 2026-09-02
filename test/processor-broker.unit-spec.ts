/**
 * Processing lifecycle (0121) — broker + run-service unit coverage over
 * a mocked Surreal connection:
 *  - flag off ⇒ 503 with ZERO queries issued (byte-identity, off state);
 *  - adapter matching picks by capability AND accepts();
 *  - no installed adapter ⇒ a denied entry, no run row;
 *  - over-cap output ⇒ the run fails, no representation is written;
 *  - error text is capped (500) and PII-redacted before the row write.
 */
import { ServiceUnavailableException } from '@nestjs/common';
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

const manifest = (memoryModel?: Record<string, unknown>): DomainPackManifest =>
  ({
    id: 'proc_pack',
    version: '1.0.0',
    description: 'Synthetic processor pack (unit).',
    predicates: [],
    ...(memoryModel ? { memoryModel } : {}),
  }) as unknown as DomainPackManifest;

const PACK = manifest({
  modalities: ['image'],
  processors: [{ id: 'img_cap', modality: 'image', produces: ['caption'] }],
});
const CHECKSUM = modalitiesChecksum(declaredModalitySection(PACK));

const stubAdapter = (over: Partial<ProcessorAdapter> = {}): ProcessorAdapter => ({
  capability: 'caption',
  version: 'stub-v1',
  configParts: () => [],
  accepts: () => true,
  process: () => Promise.resolve([{ kind: 'caption', content: 'ok' }]),
  ...over,
});

interface IssuedQuery {
  sql: string;
  vars: Record<string, unknown> | undefined;
}

function fixture(opts: { adapters: ProcessorAdapter[]; packRow?: Record<string, unknown> }) {
  const queries: IssuedQuery[] = [];
  const assetRow = {
    id: 'evidence_asset:a1',
    modality: 'image',
    mediaType: 'image/png',
    availability: 'external',
    byteLength: 10,
    width: 2,
    height: 3,
  };
  const packRow = opts.packRow ?? {
    manifest: PACK,
    acceptedModalities: true,
    acceptedModalitiesChecksum: CHECKSUM,
  };
  const db = {
    query: jest.fn((sql: string, vars?: Record<string, unknown>) => {
      queries.push({ sql, vars });
      if (sql.includes("type::record('evidence_asset'")) return Promise.resolve([[assetRow]]);
      if (sql.includes('FROM domain_pack')) return Promise.resolve([[packRow]]);
      if (sql.includes('INSERT IGNORE INTO processing_run')) {
        return Promise.resolve([[{ id: (vars?.row as { id: unknown }).id }]]);
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
  const broker = new EvidenceProcessorBrokerService(surreal, opts.adapters, runs);
  return { broker, store, surreal, queries };
}

describe('EvidenceProcessorBrokerService', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [
      'EVIDENCE_PROCESSOR_BROKER',
      'EVIDENCE_SUBSTRATE_ENABLED',
      'EVIDENCE_DERIVED_MAX_BYTES',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.EVIDENCE_PROCESSOR_BROKER = '1';
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('flag off ⇒ 503 and ZERO queries issued', async () => {
    delete process.env.EVIDENCE_PROCESSOR_BROKER;
    const f = fixture({ adapters: [stubAdapter()] });
    await expect(
      f.broker.dispatchForPack('co_x', { packId: 'proc_pack', assetId: 'evidence_asset:a1' }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(f.surreal.withCompany).not.toHaveBeenCalled();
    expect(f.queries).toHaveLength(0);
  });

  it('substrate off ⇒ 503 too (the broker writes through the substrate seam)', async () => {
    delete process.env.EVIDENCE_SUBSTRATE_ENABLED;
    const f = fixture({ adapters: [stubAdapter()] });
    await expect(
      f.broker.dispatchForPack('co_x', { packId: 'proc_pack', assetId: 'evidence_asset:a1' }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(f.queries).toHaveLength(0);
  });

  it('matches by capability AND accepts() — first accepting adapter wins', async () => {
    const rejecting = stubAdapter({
      version: 'rejecting-v1',
      accepts: (_m, mediaType) => mediaType === 'image/jpeg', // not our png
    });
    const wrongCap = stubAdapter({ capability: 'ocr', version: 'wrong-cap-v1' });
    const accepting = stubAdapter({ version: 'accepting-v1' });
    const spy = jest.spyOn(accepting, 'process');
    const f = fixture({ adapters: [wrongCap, rejecting, accepting] });
    const res = await f.broker.dispatchForPack('co_x', {
      packId: 'proc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(res.denied).toHaveLength(0);
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]).toMatchObject({ capability: 'caption', status: 'succeeded' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(f.store.addRepresentation).toHaveBeenCalledWith(
      'co_x',
      expect.objectContaining({
        producerVersion: 'accepting-v1',
        producedByRun: res.runs[0]!.runId,
      }),
    );
  });

  it('no installed adapter ⇒ denied entry and NO run row', async () => {
    const f = fixture({ adapters: [stubAdapter({ capability: 'ocr' })] });
    const res = await f.broker.dispatchForPack('co_x', {
      packId: 'proc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(res.runs).toHaveLength(0);
    expect(res.denied).toEqual([{ capability: 'caption', reason: 'no installed processor' }]);
    expect(f.queries.some((q) => q.sql.includes('INSERT IGNORE INTO processing_run'))).toBe(false);
  });

  it('over-cap output ⇒ run failed, no representation write', async () => {
    process.env.EVIDENCE_DERIVED_MAX_BYTES = '4';
    const f = fixture({
      adapters: [
        stubAdapter({
          process: () => Promise.resolve([{ kind: 'caption', content: 'way past the cap' }]),
        }),
      ],
    });
    const res = await f.broker.dispatchForPack('co_x', {
      packId: 'proc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(res.runs[0]).toMatchObject({ status: 'failed', representationIds: [] });
    expect(f.store.addRepresentation).not.toHaveBeenCalled();
    const fail = f.queries.find((q) => q.sql.includes(`status = 'failed'`));
    expect(fail).toBeDefined();
    expect(String(fail!.vars!.e)).toContain('derived output exceeds EVIDENCE_DERIVED_MAX_BYTES');
  });

  it('error text is capped at 500 chars and PII-redacted before the row write', async () => {
    const f = fixture({
      adapters: [
        stubAdapter({
          process: () => Promise.reject(new Error(`contact test@example.com ${'x'.repeat(600)}`)),
        }),
      ],
    });
    const res = await f.broker.dispatchForPack('co_x', {
      packId: 'proc_pack',
      assetId: 'evidence_asset:a1',
    });
    expect(res.runs[0]).toMatchObject({ status: 'failed' });
    const fail = f.queries.find((q) => q.sql.includes(`status = 'failed'`));
    const stored = String(fail!.vars!.e);
    expect(stored.length).toBeLessThanOrEqual(500);
    expect(stored).toContain('[EMAIL]');
    expect(stored).not.toContain('test@example.com');
  });
});
