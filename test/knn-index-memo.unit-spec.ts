/**
 * The dropped-KNN-operator memo (review 2026-09-09, V-3).
 *
 * Detecting a dropped `<|k,ef|>` operator after the fact used to cost, on
 * EVERY query of an un-indexed tenant: the KNN table scan, two INFO
 * round-trips, an ERROR log line, then the exact scan. With
 * `SEARCH_HNSW_ENABLED=1` global and index creation per tenant, that was
 * the steady state of production. These pin the memo: skip the KNN attempt
 * while the observation is fresh, probe once per TTL, shout once per hour.
 */
import {
  KNN_INDEX_MEMO_TTL_MS,
  KNN_INDEX_WARN_EVERY_MS,
  knnIndexKnownUnusable,
  noteKnnOperatorDropped,
  resetKnnIndexMemo,
} from '../src/db/knn-index';
import { runVectorLeg } from '../src/search/internals/legs';
import { HnswMaintenanceService } from '../src/admin/hnsw-maintenance.service';

const SPEC = { table: 'knowledge_fact', index: 'fact_embedding_hnsw' };
const INFO_TABLE_NO_INDEX = [{ events: {}, fields: {}, indexes: {}, lives: {}, tables: {} }];
const INFO_TABLE_WITH_INDEX = [
  {
    events: {},
    fields: {},
    indexes: { fact_embedding_hnsw: 'DEFINE INDEX …' },
    lives: {},
    tables: {},
  },
];

/** A tenant-selected connection whose successive queries answer in order. */
function tenantDb(results: unknown[][], database = 'co_x') {
  const calls: string[] = [];
  let i = 0;
  return {
    namespace: 'brain',
    database,
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return r;
    }),
  };
}

function recordingLogger() {
  const errors: string[] = [];
  const debugs: string[] = [];
  return {
    errors,
    debugs,
    logger: {
      warn: () => {},
      error: (m: string) => errors.push(m),
      debug: (m: string) => debugs.push(m),
    },
  };
}

beforeEach(() => resetKnnIndexMemo());

describe('knn index memo', () => {
  it('is inert for a connection with no selected database (unit fakes, admin paths)', async () => {
    const db = { query: jest.fn(async () => INFO_TABLE_NO_INDEX) };
    const { logger, errors } = recordingLogger();
    await noteKnnOperatorDropped(db as never, SPEC, { logger });
    await noteKnnOperatorDropped(db as never, SPEC, { logger });
    // No key → no memo: probed and shouted both times, exactly as before.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
    expect(knnIndexKnownUnusable(db as never, SPEC)).toBe(false);
  });

  it('probes once per TTL, shouts once per hour, and marks the tenant unusable meanwhile', async () => {
    const db = tenantDb([INFO_TABLE_NO_INDEX]);
    const { logger, errors, debugs } = recordingLogger();
    const t0 = 1_800_000_000_000;

    expect(await noteKnnOperatorDropped(db as never, SPEC, { logger, now: t0 })).toBe('absent');
    expect(db.calls).toEqual(['INFO FOR TABLE knowledge_fact;']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('/v1/admin/maintenance/hnsw');
    expect(knnIndexKnownUnusable(db as never, SPEC, t0 + 1)).toBe(true);

    // Inside the TTL: no probe, no shout — and no extension of the skip.
    await noteKnnOperatorDropped(db as never, SPEC, {
      logger,
      now: t0 + KNN_INDEX_MEMO_TTL_MS - 1,
    });
    expect(db.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(debugs).toHaveLength(1);

    // Past the TTL: the skip lapses and the next drop probes again — but
    // the operator has already been told this hour.
    expect(knnIndexKnownUnusable(db as never, SPEC, t0 + KNN_INDEX_MEMO_TTL_MS)).toBe(false);
    await noteKnnOperatorDropped(db as never, SPEC, { logger, now: t0 + KNN_INDEX_MEMO_TTL_MS });
    expect(db.calls).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(debugs).toHaveLength(2);

    // An hour on, the shout is due again.
    await noteKnnOperatorDropped(db as never, SPEC, { logger, now: t0 + KNN_INDEX_WARN_EVERY_MS });
    expect(errors).toHaveLength(2);
  });

  it('keys per tenant database and per index', async () => {
    const a = tenantDb([INFO_TABLE_NO_INDEX], 'co_a');
    const b = tenantDb([INFO_TABLE_NO_INDEX], 'co_b');
    await noteKnnOperatorDropped(a as never, SPEC);
    expect(knnIndexKnownUnusable(a as never, SPEC)).toBe(true);
    expect(knnIndexKnownUnusable(b as never, SPEC)).toBe(false);
    expect(
      knnIndexKnownUnusable(a as never, {
        table: 'episode_segment',
        index: 'segment_embedding_hnsw',
      }),
    ).toBe(false);
  });

  it('does not skip on an inconclusive probe, and forgets everything on reset', async () => {
    const failing = {
      namespace: 'brain',
      database: 'co_x',
      query: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    expect(await noteKnnOperatorDropped(failing as never, SPEC)).toBe('unknown');
    // `unknown` could be transient: keep trying the index.
    expect(knnIndexKnownUnusable(failing as never, SPEC)).toBe(false);

    const absent = tenantDb([INFO_TABLE_NO_INDEX], 'co_y');
    await noteKnnOperatorDropped(absent as never, SPEC);
    expect(knnIndexKnownUnusable(absent as never, SPEC)).toBe(true);
    resetKnnIndexMemo();
    expect(knnIndexKnownUnusable(absent as never, SPEC)).toBe(false);
  });

  it('a still-building index is skipped too (it serves the same unranked rows)', async () => {
    const db = tenantDb([
      INFO_TABLE_WITH_INDEX,
      [{ building: { initial: 16, pending: 0, status: 'indexing' } }],
    ]);
    expect(await noteKnnOperatorDropped(db as never, SPEC)).toBe('building');
    expect(knnIndexKnownUnusable(db as never, SPEC)).toBe(true);
  });
});

describe('search vector leg with the memo', () => {
  const embedder = { embed: async () => [0.1, 0.2, 0.3] };
  const tuning = {
    combinedVectorGraph: false,
    hnswEnabled: true,
    hnswEf: 100,
    hnswOverfetch: 4,
    highlightEnabled: false,
  };
  const legArgs = (db: unknown, logger: unknown) => ({
    db: db as never,
    embedder: embedder as never,
    query: 'who is ada',
    k: 5,
    baseWhere: { sql: '', params: {} },
    tuning,
    logger: logger as never,
  });

  it('pays the KNN scan and the probe once, then goes straight to the exact scan', async () => {
    const { logger, errors } = recordingLogger();
    const first = tenantDb([
      [[{ id: 'f1', knnDist: null }]],
      INFO_TABLE_NO_INDEX,
      [[{ id: 'f9', simScore: 0.91 }]],
    ]);
    expect(await runVectorLeg(legArgs(first, logger))).toEqual([{ id: 'f9', simScore: 0.91 }]);
    expect(first.calls).toHaveLength(3);
    expect(errors).toHaveLength(1);

    // Same tenant, another pooled connection: one statement, no diagnostics.
    const second = tenantDb([[[{ id: 'f9', simScore: 0.91 }]]]);
    expect(await runVectorLeg(legArgs(second, logger))).toEqual([{ id: 'f9', simScore: 0.91 }]);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).toContain('vector::similarity::cosine');
    expect(errors).toHaveLength(1);
  });
});

describe('hnsw maintenance and the memo', () => {
  const INFO = (state: 'ready' | 'absent') => [
    {
      events: {},
      fields: {},
      indexes:
        state === 'absent'
          ? {}
          : Object.fromEntries(
              ['fact_embedding_hnsw', 'segment_embedding_hnsw'].map((n) => [
                n,
                `DEFINE INDEX ${n} …`,
              ]),
            ),
      lives: {},
      tables: {},
    },
  ];

  function maintenance(state: 'ready' | 'indexing') {
    const withCompany = jest.fn(async <T>(_c: string, fn: (d: unknown) => Promise<T>) =>
      fn({
        namespace: 'brain',
        database: 'co_x',
        query: async (sql: string) => {
          if (sql.startsWith('INFO FOR TABLE')) return INFO('ready');
          if (sql.startsWith('INFO FOR INDEX')) return [{ building: { status: state } }];
          return [null];
        },
      }),
    );
    const svc = new HnswMaintenanceService(
      { withCompany } as never,
      { primaryDimensions: () => 1024, primarySpaceId: () => 'bge-m3:Xenova/bge-m3:1024' } as never,
    );
    return { svc, withCompany };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('a build clears the memo so the legs try the index again at once', async () => {
    const tenant = tenantDb([INFO_TABLE_NO_INDEX]);
    await noteKnnOperatorDropped(tenant as never, SPEC);
    expect(knnIndexKnownUnusable(tenant as never, SPEC)).toBe(true);
    await maintenance('ready').svc.apply('co_x', 'create', { waitMs: 0 });
    expect(knnIndexKnownUnusable(tenant as never, SPEC)).toBe(false);
  });

  it("action:'status' leaves the memo alone", async () => {
    const tenant = tenantDb([INFO_TABLE_NO_INDEX]);
    await noteKnnOperatorDropped(tenant as never, SPEC);
    await maintenance('ready').svc.apply('co_x', 'status');
    expect(knnIndexKnownUnusable(tenant as never, SPEC)).toBe(true);
  });

  it('waits for a concurrent build with a fresh pool hold per poll, never one long one', async () => {
    jest.useFakeTimers();
    const { svc, withCompany } = maintenance('indexing');
    const pending = svc.apply('co_x', 'create', { waitMs: 2500 });
    await jest.advanceTimersByTimeAsync(0);
    // DDL + first probe: one hold, released before the wait begins.
    expect(withCompany).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(withCompany).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(withCompany).toHaveBeenCalledTimes(3);
    expect(res.ready).toBe(false);
  });
});
