/**
 * Unit coverage for the orphan-blob GC
 * (src/evidence/orphan-blob-gc.service.ts, EVIDENCE_ORPHAN_BLOB_GC) —
 * the pass that DELETES bytes, so every safety property gets its own
 * pin:
 *
 *  - default-off: no store walk, no query, no unlink;
 *  - orphan DETECTION: a referenced blob is never selected, and a SHARED
 *    blob (two rows, one ref — the case content-addressed storage makes
 *    real) stays untouched when only one of its rows dies;
 *  - every row state counts as a reference, including a 'gone' tombstone
 *    that still holds its ref and a quarantined row;
 *  - the grace window protects a young blob (bytes whose row may still
 *    be in flight);
 *  - the 0114 hard-erasure outbox owns its refs — the sweep steps over
 *    them rather than racing the drainer;
 *  - dry run reports everything and deletes nothing (the flag's first
 *    stage, and a caller can only tighten it, never loosen);
 *  - the deletion cap and the wall-clock budget both bite, and say so;
 *  - the last-moment re-check saves a blob that gained a row mid-sweep;
 *  - failure isolation: one delete that throws costs one blob, not the
 *    run — and an adapter that cannot enumerate per tenant collects
 *    nothing;
 *  - roster isolation: one tenant's throw does not cost the next tenant.
 *
 * Collaborators are stubbed positionally — no Nest DI, no Surreal, no
 * filesystem, no paid call anywhere.
 */
import { EvidenceOrphanBlobGcService } from '../src/evidence/orphan-blob-gc.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { SurrealService } from '../src/db/surreal.service';
import type {
  EvidenceStorageAdapter,
  EvidenceStorageRegistry,
  StoredBlobEntry,
} from '../src/evidence/storage/storage-adapter';

const FLAGS = [
  'EVIDENCE_ORPHAN_BLOB_GC',
  'EVIDENCE_ORPHAN_BLOB_GC_DELETE',
  'EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED',
  'EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS',
  'EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS',
  'EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS',
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.EVIDENCE_ORPHAN_BLOB_GC = '1';
  process.env.EVIDENCE_ORPHAN_BLOB_GC_DELETE = '1';
  process.env.EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS = '1';
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const HOUR = 3600_000;
const ref = (tenant: string, n: number) => `fs://${tenant}/${String(n).repeat(64).slice(0, 64)}`;

/** An evidence_asset row as the sweep's only join key sees it. */
interface FakeAsset {
  id: string;
  /** A row may point at a blob whose hash is not its own — see the sweep. */
  storageRef?: string;
  availability?: string;
  quarantineStatus?: string;
}

interface FakeTenant {
  assets: FakeAsset[];
  /** 0114 outbox rows: refs the hard-erasure drainer already owns. */
  queued?: string[];
  throws?: string;
  /** Fires after each batch resolve — the mid-sweep race hook. */
  afterResolve?: (() => void) | undefined;
}

function makeSurreal(tenants: Record<string, FakeTenant>): {
  surreal: SurrealService;
  queries: string[];
} {
  const queries: string[] = [];
  const surreal = {
    withCompany: async <T>(companyId: string, fn: (db: unknown) => Promise<T>) => {
      const t = tenants[companyId];
      if (!t) throw new Error(`no fake tenant ${companyId}`);
      if (t.throws) throw new Error(t.throws);
      const db = {
        query: <R>(sql: string, params?: Record<string, unknown>): Promise<R> => {
          queries.push(sql);
          const refs = new Set((params?.refs as string[]) ?? []);
          if (sql.includes('FROM evidence_asset')) {
            const hits = t.assets
              .map((a) => a.storageRef)
              .filter((r): r is string => r !== undefined && refs.has(r));
            return Promise.resolve([hits] as unknown as R);
          }
          if (sql.includes('FROM evidence_blob_gc')) {
            return Promise.resolve([(t.queued ?? []).filter((r) => refs.has(r))] as unknown as R);
          }
          throw new Error(`unexpected query: ${sql}`);
        },
      };
      const out = await fn(db);
      t.afterResolve?.();
      return out;
    },
  } as unknown as SurrealService;
  return { surreal, queries };
}

interface FakeStore {
  /** ref → { byteLength, ageMs } as the store would report it. */
  blobs: Array<{ ref: string; byteLength: number; ageMs: number }>;
  deleted: string[];
  failOn?: string[];
  listed: string[];
  tmpSwept: Array<{ olderThanMs: number; dryRun: boolean }>;
}

function makeStore(blobs: FakeStore['blobs']): FakeStore {
  return { blobs, deleted: [], listed: [], tmpSwept: [] };
}

function makeAdapter(
  store: FakeStore,
  opts: { enumerable?: boolean; ownsTenant?: (companyId: string, r: string) => boolean } = {},
): EvidenceStorageAdapter {
  const owns =
    opts.ownsTenant ?? ((companyId: string, r: string) => r.startsWith(`fs://${companyId}/`));
  const adapter: Partial<EvidenceStorageAdapter> = {
    scheme: 'fs',
    belongsToTenant: (companyId: string, r: string) => owns(companyId, r),
    delete: (r: string) => {
      if (store.failOn?.includes(r)) return Promise.reject(new Error('EACCES'));
      store.deleted.push(r);
      const i = store.blobs.findIndex((b) => b.ref === r);
      if (i < 0) return Promise.resolve(false);
      store.blobs.splice(i, 1);
      return Promise.resolve(true);
    },
    sweepIncompleteWrites: (_companyId, o) => {
      store.tmpSwept.push(o);
      return Promise.resolve({ found: 1, removed: o.dryRun ? 0 : 1 });
    },
  };
  if (opts.enumerable !== false) {
    adapter.listBlobs = (companyId: string): AsyncGenerator<StoredBlobEntry> => {
      store.listed.push(companyId);
      // Snapshot: the sweep deletes while iterating, exactly as it does
      // against a real directory walk.
      const snapshot = [...store.blobs];
      return (async function* () {
        for (const b of snapshot) {
          yield {
            storageRef: b.ref,
            byteLength: b.byteLength,
            modifiedAtMs: Date.now() - b.ageMs,
          };
        }
      })();
    };
  }
  return adapter as EvidenceStorageAdapter;
}

function makeService(
  tenants: Record<string, FakeTenant>,
  store: FakeStore,
  adapterOpts: Parameters<typeof makeAdapter>[1] = {},
): {
  service: EvidenceOrphanBlobGcService;
  queries: string[];
} {
  const { surreal, queries } = makeSurreal(tenants);
  const apiKeys = { knownCompanyIds: () => Object.keys(tenants) } as unknown as ApiKeyService;
  const registry: EvidenceStorageRegistry = new Map([['fs', makeAdapter(store, adapterOpts)]]);
  return {
    service: new EvidenceOrphanBlobGcService(surreal, apiKeys, registry),
    queries,
  };
}

describe('orphan blob GC — default off', () => {
  it('does not walk the store, query, or unlink while the flag is off', async () => {
    delete process.env.EVIDENCE_ORPHAN_BLOB_GC;
    const store = makeStore([{ ref: ref('co_a', 1), byteLength: 10, ageMs: 5 * HOUR }]);
    const { service, queries } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.scanned).toBe(0);
    expect(result.orphans).toBe(0);
    expect(store.listed).toEqual([]);
    expect(store.deleted).toEqual([]);
    expect(store.tmpSwept).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('nightly cron is a no-op unless the schedule knob is on too', async () => {
    const store = makeStore([{ ref: ref('co_a', 1), byteLength: 10, ageMs: 5 * HOUR }]);
    const { service, queries } = makeService({ co_a: { assets: [] } }, store);

    expect(await service.runNightly()).toEqual({
      tenants: [],
      budgetExhausted: false,
      skippedForBudget: 0,
    });
    expect(queries).toEqual([]);

    process.env.EVIDENCE_ORPHAN_BLOB_GC_SCHEDULED = '1';
    const run = await service.runNightly();
    expect(run.tenants).toHaveLength(1);
    expect(store.deleted).toEqual([ref('co_a', 1)]);
  });
});

describe('orphan blob GC — detection', () => {
  it('never selects a blob a live row references', async () => {
    const kept = ref('co_a', 1);
    const orphan = ref('co_a', 2);
    const store = makeStore([
      { ref: kept, byteLength: 10, ageMs: 5 * HOUR },
      { ref: orphan, byteLength: 20, ageMs: 5 * HOUR },
    ]);
    const { service } = makeService(
      { co_a: { assets: [{ id: 'evidence_asset:a', storageRef: kept }] } },
      store,
    );

    const result = await service.sweepTenant('co_a');

    expect(result.scanned).toBe(2);
    expect(result.referenced).toBe(1);
    expect(result.orphans).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.bytesDeleted).toBe(20);
    expect(store.deleted).toEqual([orphan]);
    expect(store.blobs.map((b) => b.ref)).toEqual([kept]);
  });

  it('never selects a SHARED blob while a second row still points at it', async () => {
    // The case content-addressed storage makes real: registerAsset takes
    // an explicit storageRef, so two rows can back onto one blob. Row
    // one is gone (GDPR, retention, a rejected scan); row two survives
    // and its citations still need the bytes.
    const shared = ref('co_a', 3);
    const store = makeStore([{ ref: shared, byteLength: 99, ageMs: 5 * HOUR }]);
    const { service } = makeService(
      {
        co_a: {
          assets: [
            { id: 'evidence_asset:survivor', storageRef: shared },
            // The dead row is simply absent — what the sweep sees after
            // the other owner's erasure ran.
          ],
        },
      },
      store,
    );

    const result = await service.sweepTenant('co_a');

    expect(result.referenced).toBe(1);
    expect(result.orphans).toBe(0);
    expect(result.deleted).toBe(0);
    expect(store.deleted).toEqual([]);
  });

  it('counts every row state as a reference — tombstones and quarantine included', async () => {
    const tombstoned = ref('co_a', 4);
    const quarantined = ref('co_a', 5);
    const store = makeStore([
      { ref: tombstoned, byteLength: 1, ageMs: 5 * HOUR },
      { ref: quarantined, byteLength: 1, ageMs: 5 * HOUR },
    ]);
    const { service } = makeService(
      {
        co_a: {
          assets: [
            // 'gone' + a surviving ref is the reconciliation leg's retry
            // state: its blob delete failed, and the retention sweep owns
            // the retry. Not this pass's blob.
            { id: 'evidence_asset:t', storageRef: tombstoned, availability: 'gone' },
            { id: 'evidence_asset:q', storageRef: quarantined, quarantineStatus: 'quarantined' },
          ],
        },
      },
      store,
    );

    const result = await service.sweepTenant('co_a');

    expect(result.referenced).toBe(2);
    expect(result.orphans).toBe(0);
    expect(store.deleted).toEqual([]);
  });

  it('leaves refs the 0114 hard-erasure outbox already owns to their drainer', async () => {
    const condemned = ref('co_a', 6);
    const store = makeStore([{ ref: condemned, byteLength: 7, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [], queued: [condemned] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.queued).toBe(1);
    expect(result.orphans).toBe(0);
    expect(store.deleted).toEqual([]);
  });
});

describe('orphan blob GC — grace window', () => {
  it('skips a blob younger than the window whatever its reference state', async () => {
    const young = ref('co_a', 7);
    const old = ref('co_a', 8);
    const store = makeStore([
      // An upload in flight: bytes on disk, row not written yet.
      { ref: young, byteLength: 5, ageMs: 60_000 },
      { ref: old, byteLength: 5, ageMs: 5 * HOUR },
    ]);
    const { service } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.young).toBe(1);
    expect(result.orphans).toBe(1);
    expect(store.deleted).toEqual([old]);
  });

  it('protects everything under the generous default window', async () => {
    delete process.env.EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS; // → 24 h
    const store = makeStore([{ ref: ref('co_a', 9), byteLength: 5, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.young).toBe(1);
    expect(result.orphans).toBe(0);
    expect(store.deleted).toEqual([]);
  });

  it('falls back to the default window when the knob is nonsense', async () => {
    process.env.EVIDENCE_ORPHAN_BLOB_GC_GRACE_HOURS = 'soon';
    const store = makeStore([{ ref: ref('co_a', 9), byteLength: 5, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [] } }, store);

    expect((await service.sweepTenant('co_a')).orphans).toBe(0);
  });
});

describe('orphan blob GC — dry run', () => {
  it('reports every orphan and deletes nothing while the delete flag is off', async () => {
    delete process.env.EVIDENCE_ORPHAN_BLOB_GC_DELETE;
    const orphans = [ref('co_a', 1), ref('co_a', 2)];
    const store = makeStore(orphans.map((r) => ({ ref: r, byteLength: 16, ageMs: 5 * HOUR })));
    const { service } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.dryRun).toBe(true);
    expect(result.orphans).toBe(2);
    expect(result.bytesReclaimable).toBe(32);
    expect(result.deleted).toBe(0);
    expect(result.bytesDeleted).toBe(0);
    expect(result.sampleOrphans).toEqual(orphans);
    expect(store.deleted).toEqual([]);
    // The partial-write leg honours the same report-only contract.
    expect(store.tmpSwept).toEqual([{ olderThanMs: HOUR, dryRun: true }]);
    expect(result.partialWrites).toBe(1);
    expect(result.partialWritesRemoved).toBe(0);
  });

  it('lets a caller force a dry run in stage two, but never the reverse', async () => {
    const orphan = ref('co_a', 1);
    const store = makeStore([{ ref: orphan, byteLength: 16, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [] } }, store);

    expect((await service.sweepTenant('co_a', { dryRun: true })).deleted).toBe(0);
    expect(store.deleted).toEqual([]);

    // …and the reverse is not on offer: with the flag off, asking for a
    // real run still gets a dry one.
    delete process.env.EVIDENCE_ORPHAN_BLOB_GC_DELETE;
    const forced = await service.sweepTenant('co_a', { dryRun: false });
    expect(forced.dryRun).toBe(true);
    expect(store.deleted).toEqual([]);
  });
});

describe('orphan blob GC — bounds', () => {
  it('honours the per-tenant deletion cap and says it bit', async () => {
    process.env.EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS = '2';
    const store = makeStore(
      [1, 2, 3, 4, 5].map((n) => ({ ref: ref('co_a', n), byteLength: 1, ageMs: 5 * HOUR })),
    );
    const { service } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.deleted).toBe(2);
    expect(store.deleted).toHaveLength(2);
    expect(result.capReached).toBe(true);
    // A capped run still REPORTS the whole backlog — that is how an
    // operator learns the true size of what is left.
    expect(result.orphans).toBe(5);
  });

  it('lets a caller tighten the cap for one run, never raise it', async () => {
    process.env.EVIDENCE_ORPHAN_BLOB_GC_MAX_DELETIONS = '2';
    const store = makeStore(
      [1, 2, 3, 4].map((n) => ({ ref: ref('co_a', n), byteLength: 1, ageMs: 5 * HOUR })),
    );
    const { service } = makeService({ co_a: { assets: [] } }, store);

    expect((await service.sweepTenant('co_a', { maxDeletions: 1 })).deleted).toBe(1);
    expect((await service.sweepTenant('co_a', { maxDeletions: 99 })).deleted).toBe(2);
  });

  it('stops the roster once the wall-clock budget is spent', async () => {
    process.env.EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS = '1';
    const store = makeStore([{ ref: ref('co_a', 1), byteLength: 1, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [] }, co_b: { assets: [] } }, store);

    // The deadline is stamped from the first read; every read after it
    // is far enough ahead that the roster never starts a tenant.
    const now = Date.now();
    let reads = 0;
    const spy = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => (reads++ === 0 ? now : now + 10_000));
    try {
      const run = await service.runAll();
      expect(run.budgetExhausted).toBe(true);
      expect(run.skippedForBudget).toBe(2);
      expect(run.tenants).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(store.deleted).toEqual([]);
  });
});

describe('orphan blob GC — races and failures', () => {
  it('re-checks immediately before the unlink and spares a blob that gained a row', async () => {
    const raced = ref('co_a', 1);
    const store = makeStore([{ ref: raced, byteLength: 4, ageMs: 5 * HOUR }]);
    const tenant: FakeTenant = { assets: [] };
    // The batch resolve sees no row; a registration lands before the
    // delete (put() is idempotent, so a fresh upload of identical bytes
    // reuses exactly this blob and then writes its row).
    tenant.afterResolve = () => {
      tenant.assets = [{ id: 'evidence_asset:fresh', storageRef: raced }];
      tenant.afterResolve = undefined;
    };
    const { service } = makeService({ co_a: tenant }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.orphans).toBe(1);
    expect(result.raced).toBe(1);
    expect(result.deleted).toBe(0);
    expect(store.deleted).toEqual([]);
  });

  it('isolates a delete failure: one blob lost, the run continues', async () => {
    const bad = ref('co_a', 1);
    const good = ref('co_a', 2);
    const store = makeStore([
      { ref: bad, byteLength: 1, ageMs: 5 * HOUR },
      { ref: good, byteLength: 1, ageMs: 5 * HOUR },
    ]);
    store.failOn = [bad];
    const { service } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.error).toBeUndefined();
    expect(store.deleted).toEqual([good]);
    // Idempotent + resumable: the failure is rediscovered next run, no
    // queue required.
    store.failOn = [];
    expect((await service.sweepTenant('co_a')).deleted).toBe(1);
    expect(store.blobs).toEqual([]);
  });

  it('never judges a ref the adapter does not scope to this tenant', async () => {
    const foreign = 'fs://co_other/' + 'a'.repeat(64);
    const store = makeStore([{ ref: foreign, byteLength: 1, ageMs: 5 * HOUR }]);
    const { service, queries } = makeService({ co_a: { assets: [] } }, store);

    const result = await service.sweepTenant('co_a');

    expect(result.foreign).toBe(1);
    expect(result.orphans).toBe(0);
    expect(store.deleted).toEqual([]);
    // Nothing was even asked of the database — a ref this tenant does
    // not own cannot be judged against this tenant's rows.
    expect(queries.filter((q) => q.includes('evidence_asset'))).toEqual([]);
  });

  it('collects nothing from an adapter that cannot enumerate per tenant', async () => {
    const store = makeStore([{ ref: ref('co_a', 1), byteLength: 1, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [] } }, store, { enumerable: false });

    const result = await service.sweepTenant('co_a');

    expect(result.scanned).toBe(0);
    expect(result.orphans).toBe(0);
    expect(store.deleted).toEqual([]);
    // …but an adapter that CAN clean its own interrupted writes still does.
    expect(result.partialWritesRemoved).toBe(1);
  });

  it('isolates a failing tenant from the rest of the roster', async () => {
    const store = makeStore([
      { ref: ref('co_a', 1), byteLength: 1, ageMs: 5 * HOUR },
      { ref: ref('co_b', 1), byteLength: 1, ageMs: 5 * HOUR },
    ]);
    const { service } = makeService(
      { co_a: { assets: [], throws: 'surreal is down' }, co_b: { assets: [] } },
      store,
    );

    const run = await service.runAll();

    expect(run.tenants.map((t) => t.companyId)).toEqual(['co_a', 'co_b']);
    expect(run.tenants[0]!.error).toBe('surreal is down');
    expect(run.tenants[1]!.error).toBeUndefined();
    // The failing tenant's blob is untouched; the next tenant still runs.
    expect(store.deleted).toEqual([ref('co_b', 1)]);
  });
});

describe('orphan blob GC — idempotence', () => {
  it('is a no-op on a second pass over a swept store', async () => {
    const store = makeStore([{ ref: ref('co_a', 1), byteLength: 3, ageMs: 5 * HOUR }]);
    const { service } = makeService({ co_a: { assets: [] } }, store);

    expect((await service.sweepTenant('co_a')).deleted).toBe(1);

    const second = await service.sweepTenant('co_a');
    expect(second.scanned).toBe(0);
    expect(second.orphans).toBe(0);
    expect(second.deleted).toBe(0);
  });
});
