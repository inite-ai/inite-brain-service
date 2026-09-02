/**
 * Quarantine seam (0121 MM-6) — unit coverage:
 *  - flag off ⇒ 503, no queries (byte-identity, off state);
 *  - allow-all stub hook ⇒ quarantined → scanning → clean;
 *  - rejecting hook ⇒ 'rejected' + 'gone' stamps, then the tombstone leg;
 *  - store tombstone leg: dependents purged and a FAILED blob delete
 *    KEEPS storageRef (reconcileGoneBlobs retries next sweep).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import type { SurrealService } from '../src/db/surreal.service';
import { EvidenceStoreService } from '../src/evidence/evidence-store.service';
import { AllowAllScanHook, type EvidenceScanHook } from '../src/evidence/processing/scan-hook';
import { EvidenceQuarantineService } from '../src/evidence/quarantine.service';

interface IssuedQuery {
  sql: string;
  vars: Record<string, unknown> | undefined;
}

function mockDbHarness(assetRow: Record<string, unknown> | undefined) {
  const queries: IssuedQuery[] = [];
  const db = {
    query: jest.fn((sql: string, vars?: Record<string, unknown>) => {
      queries.push({ sql, vars });
      if (sql.includes("type::record('evidence_asset'")) return Promise.resolve([[assetRow]]);
      return Promise.resolve([[]]);
    }),
  };
  const surreal = {
    withCompany: jest.fn((_c: string, fn: (d: typeof db) => unknown) => fn(db)),
  } as unknown as SurrealService;
  return { surreal, queries };
}

describe('EvidenceQuarantineService.runScan', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['EVIDENCE_QUARANTINE', 'EVIDENCE_SUBSTRATE_ENABLED'])
      saved[k] = process.env[k];
    process.env.EVIDENCE_QUARANTINE = '1';
    process.env.EVIDENCE_SUBSTRATE_ENABLED = '1';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const quarantinedRow = {
    id: 'evidence_asset:q1',
    modality: 'image',
    mediaType: 'image/png',
    byteLength: 9,
    storageRef: 'fs://co_q/aa',
    quarantineStatus: 'quarantined',
  };

  const service = (h: ReturnType<typeof mockDbHarness>, hook: EvidenceScanHook) =>
    new EvidenceQuarantineService(
      h.surreal,
      { tombstoneAssetBytes: jest.fn(() => Promise.resolve({ blobDeleted: true })) } as never,
      hook,
    );

  it('flag off ⇒ 503 and no queries', async () => {
    delete process.env.EVIDENCE_QUARANTINE;
    const h = mockDbHarness(quarantinedRow);
    await expect(
      service(h, new AllowAllScanHook()).runScan('co_q', 'evidence_asset:q1'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(h.queries).toHaveLength(0);
  });

  it('allow-all stub: quarantined → scanning → clean', async () => {
    const h = mockDbHarness(quarantinedRow);
    const res = await service(h, new AllowAllScanHook()).runScan('co_q', 'evidence_asset:q1');
    expect(res).toEqual({ assetId: 'evidence_asset:q1', quarantineStatus: 'clean' });
    const stamps = h.queries
      .filter((q) => q.sql.includes('UPDATE') && q.sql.includes('quarantineStatus'))
      .map((q) => (q.vars?.s !== undefined ? q.vars.s : q.sql));
    expect(stamps).toEqual(['scanning', 'clean']);
  });

  it("rejecting hook: stamps 'rejected'+'gone' first, then tombstones", async () => {
    const h = mockDbHarness(quarantinedRow);
    const store = {
      tombstoneAssetBytes: jest.fn(() => Promise.resolve({ blobDeleted: false })),
    };
    const rejecting: EvidenceScanHook = {
      name: 'reject-all-test',
      scan: () => Promise.resolve('rejected'),
    };
    const svc = new EvidenceQuarantineService(h.surreal, store as never, rejecting);
    const res = await svc.runScan('co_q', 'evidence_asset:q1');
    expect(res.quarantineStatus).toBe('rejected');
    expect(
      h.queries.some(
        (q) =>
          q.sql.includes(`quarantineStatus = 'rejected'`) &&
          q.sql.includes(`availability = 'gone'`),
      ),
    ).toBe(true);
    expect(store.tombstoneAssetBytes).toHaveBeenCalledWith('co_q', 'evidence_asset:q1');
  });

  it('terminal states are idempotent no-ops', async () => {
    const h = mockDbHarness({ ...quarantinedRow, quarantineStatus: 'clean' });
    const hook: EvidenceScanHook = {
      name: 'never-called',
      scan: jest.fn(() => Promise.resolve('rejected' as const)),
    };
    const res = await service(h, hook).runScan('co_q', 'evidence_asset:q1');
    expect(res.quarantineStatus).toBe('clean');
    expect(hook.scan).not.toHaveBeenCalled();
  });
});

describe('EvidenceStoreService.tombstoneAssetBytes (delete leg — flag-independent)', () => {
  it('purges dependents and KEEPS storageRef when the blob delete fails', async () => {
    const queries: IssuedQuery[] = [];
    const db = {
      query: jest.fn((sql: string, vars?: Record<string, unknown>) => {
        queries.push({ sql, vars });
        if (sql.includes("type::record('evidence_asset'")) {
          return Promise.resolve([[{ id: 'evidence_asset:t1', storageRef: 'fs://co_q/bb' }]]);
        }
        return Promise.resolve([[]]);
      }),
    };
    const surreal = {
      withCompany: jest.fn((_c: string, fn: (d: typeof db) => unknown) => fn(db)),
    } as unknown as SurrealService;
    // Empty adapter registry ⇒ deleteBlobBestEffort logs + returns false
    // (the delete FAILED) — storageRef must survive for reconciliation.
    const store = new EvidenceStoreService(surreal, new Map());
    const res = await store.tombstoneAssetBytes('co_q', 'evidence_asset:t1');
    expect(res.blobDeleted).toBe(false);
    expect(queries.some((q) => q.sql.includes(`availability = 'gone'`))).toBe(true);
    // Dependents legs issued (repr + frag + runs SELECT-ids loops).
    expect(queries.some((q) => q.sql.includes('FROM derived_representation'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('FROM evidence_fragment'))).toBe(true);
    expect(queries.some((q) => q.sql.includes('FROM processing_run'))).toBe(true);
    // The FAILED blob delete keeps the ref: no storageRef = NONE write.
    expect(queries.some((q) => q.sql.includes('storageRef = NONE'))).toBe(false);
  });
});
