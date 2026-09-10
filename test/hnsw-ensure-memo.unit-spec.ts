/**
 * The KNN legs memoise "this tenant's index is missing/building" so an
 * un-indexed tenant is not diagnosed on every query. A build or a drop makes
 * that memory stale; an `ensure` that found every index present changed
 * nothing and must leave it alone — the provisioner sweeps every tenant on a
 * schedule, and clearing the memo on each no-op re-opened the per-query
 * diagnostics for all of them.
 */
jest.mock('../src/db/knn-index', () => ({
  ...jest.requireActual('../src/db/knn-index'),
  resetKnnIndexMemo: jest.fn(),
}));

import { resetKnnIndexMemo } from '../src/db/knn-index';
import { HnswMaintenanceService } from '../src/admin/hnsw-maintenance.service';

const ALL_INDEXES = ['fact_embedding_hnsw', 'segment_embedding_hnsw'];

function fakeDb(state: 'ready' | 'absent') {
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('INFO FOR TABLE')) {
      return [
        {
          indexes: Object.fromEntries(
            (state === 'absent' ? [] : ALL_INDEXES).map((n) => [n, `DEFINE INDEX ${n} …`]),
          ),
        },
      ];
    }
    if (sql.startsWith('INFO FOR INDEX')) {
      return [{ building: { initial: 1, pending: 0, status: 'ready' } }];
    }
    return [null];
  });
  return { query };
}

function service(db: ReturnType<typeof fakeDb>) {
  const surreal = {
    withCompany: async <T>(_c: string, fn: (d: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  const embedder = { primaryDimensions: () => 1024, primarySpaceId: () => 'bge:bge-m3:1024:l2' };
  return new HnswMaintenanceService(surreal as never, embedder as never);
}

describe('hnsw maintenance — when the KNN index memo is reset', () => {
  beforeEach(() => jest.mocked(resetKnnIndexMemo).mockClear());

  it('ensure with every index present is a no-op and keeps the memo', async () => {
    const res = await service(fakeDb('ready')).apply('co1', 'ensure');
    expect(res.created).toEqual([]);
    expect(resetKnnIndexMemo).not.toHaveBeenCalled();
  });

  it('ensure that had to create an index resets it', async () => {
    const res = await service(fakeDb('absent')).apply('co1', 'ensure');
    expect(res.created).toEqual(ALL_INDEXES);
    expect(resetKnnIndexMemo).toHaveBeenCalledTimes(1);
  });

  it('create and drop reset it; status never does', async () => {
    await service(fakeDb('ready')).apply('co1', 'create', { waitMs: 0 });
    expect(resetKnnIndexMemo).toHaveBeenCalledTimes(1);
    await service(fakeDb('ready')).apply('co1', 'drop');
    expect(resetKnnIndexMemo).toHaveBeenCalledTimes(2);
    await service(fakeDb('ready')).apply('co1', 'status');
    expect(resetKnnIndexMemo).toHaveBeenCalledTimes(2);
  });
});
