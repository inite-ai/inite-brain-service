import { runVectorLeg } from '../src/search/internals/legs';
import { runDenseScanLeg } from '../src/synthesize/scan-leg';
import { hnswIndexState, knnDroppedMessage, knnOperatorDropped } from '../src/db/knn-index';

/**
 * The missing-HNSW-index defect (roadmap embedding-spaces-2026-09 §6 E1).
 *
 * SurrealDB 3.2.4 does not error when `<|K,EF|>` has no index to ride: it
 * drops the operator from the plan and answers with the table's first k
 * rows and `vector::distance::knn()` projecting NULL on each. Measured on a
 * scratch v3.2.4 container (3 000 × 1024-d):
 *
 *   no index          → [{"knnDist":null,"n":1144},{"knnDist":null,"n":2781},…]
 *   CONCURRENTLY, mid-build ({"status":"indexing"})
 *                     → the SAME null-distance rows
 *   index ready       → [{"knnDist":0.8998…,"n":1802},…]
 *
 * So every leg's documented "throws when the tenant has no index — the
 * caller falls back to the scan" was dead code, and production
 * (`SEARCH_HNSW_ENABLED=1`, per-tenant manual index creation) served
 * unranked table-order rows to any un-indexed tenant. These tests pin the
 * detection and the fallback, using the exact row shape the driver returns.
 */

interface FakeDb {
  query: jest.Mock;
  calls: string[];
}

/** A db whose successive `query` calls answer from `results` in order; the
 *  last entry repeats. Mirrors the driver's `[resultOfStatement1, …]` shape. */
function fakeDb(results: unknown[][]): FakeDb {
  const calls: string[] = [];
  let i = 0;
  const query = jest.fn(async (sql: string) => {
    calls.push(sql);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  });
  return { query, calls };
}

/** What SurrealDB returns for `INFO FOR TABLE t` with no index defined. */
const INFO_TABLE_NO_INDEX = [{ events: {}, fields: {}, indexes: {}, lives: {}, tables: {} }];
const INFO_TABLE_WITH_INDEX = [
  {
    events: {},
    fields: {},
    indexes: {
      fact_embedding_hnsw:
        'DEFINE INDEX fact_embedding_hnsw ON knowledge_fact FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16',
    },
    lives: {},
    tables: {},
  },
];

describe('knnOperatorDropped — the signal is the null distance, not an exception', () => {
  it('is true when every row of a non-empty result has a null distance', () => {
    // Verbatim from the 3.2.4 measurement with no index.
    const rows = [
      { knnDist: null, n: 1144 },
      { knnDist: null, n: 2781 },
      { knnDist: null, n: 2778 },
    ];
    expect(knnOperatorDropped(rows, 'knnDist')).toBe(true);
  });

  it('is false when the operator rode the index (numeric distances)', () => {
    const rows = [
      { knnDist: 0.8998647510844109, n: 1802 },
      { knnDist: 0.8999069422705311, n: 2007 },
    ];
    expect(knnOperatorDropped(rows, 'knnDist')).toBe(false);
  });

  it('is false for an empty result — that is gate starvation, not a missing index', () => {
    expect(knnOperatorDropped([], 'knnDist')).toBe(false);
    expect(knnOperatorDropped(null, 'knnDist')).toBe(false);
    expect(knnOperatorDropped(undefined, 'knnDist')).toBe(false);
  });

  it('one ranked row is enough to say the operator ran', () => {
    expect(knnOperatorDropped([{ knnDist: null }, { knnDist: 0.2 }], 'knnDist')).toBe(false);
  });

  it('reads whichever distance alias the caller projected', () => {
    expect(knnOperatorDropped([{ dist: null }], 'dist')).toBe(true);
    expect(knnOperatorDropped([{ dist: 0.4 }], 'dist')).toBe(false);
  });
});

describe('hnswIndexState — why the operator was dropped', () => {
  const SPEC = { table: 'knowledge_fact', index: 'fact_embedding_hnsw' };

  it('reports absent from INFO FOR TABLE without consulting INFO FOR INDEX', async () => {
    // INFO FOR INDEX THROWS on a missing index ("The index 'x' does not
    // exist"), so existence must be probed on the table.
    const db = fakeDb([INFO_TABLE_NO_INDEX]);
    expect(await hnswIndexState(db as never, SPEC)).toBe('absent');
    expect(db.calls).toEqual(['INFO FOR TABLE knowledge_fact;']);
  });

  it('reports building for an index that exists but is still indexing', async () => {
    const db = fakeDb([
      INFO_TABLE_WITH_INDEX,
      [{ building: { initial: 16, pending: 0, status: 'indexing' } }],
    ]);
    expect(await hnswIndexState(db as never, SPEC)).toBe('building');
  });

  it('reports ready once the build completes', async () => {
    const db = fakeDb([
      INFO_TABLE_WITH_INDEX,
      [{ building: { initial: 3000, pending: 0, status: 'ready', updated: 0 } }],
    ]);
    expect(await hnswIndexState(db as never, SPEC)).toBe('ready');
  });

  it('never escalates a diagnostic failure into a query failure', async () => {
    const db = {
      query: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    await expect(hnswIndexState(db as never, SPEC)).resolves.toBe('unknown');
  });

  it('names the remedy for each state', () => {
    const spec = { table: 'knowledge_fact', index: 'fact_embedding_hnsw' };
    expect(knnDroppedMessage(spec, 'absent')).toContain('/v1/admin/maintenance/hnsw');
    expect(knnDroppedMessage(spec, 'building')).toContain('still building');
    expect(knnDroppedMessage(spec, 'unknown')).toContain('could not be determined');
  });
});

describe('search vector leg — a dropped KNN operator falls back to the exact scan', () => {
  const embedder = { embed: async () => [0.1, 0.2, 0.3] };
  const tuning = {
    combinedVectorGraph: false,
    hnswEnabled: true,
    hnswEf: 100,
    hnswOverfetch: 4,
    highlightEnabled: false,
  };
  const legArgs = (db: FakeDb, logger?: object) => ({
    db: db as never,
    embedder: embedder as never,
    query: 'who is ada',
    k: 5,
    baseWhere: { sql: 'AND status = "active"', params: {} },
    tuning,
    ...(logger ? { logger: logger as never } : {}),
  });

  it('never returns unranked table-order rows as if they were ranked', async () => {
    const db = fakeDb([
      // 1. the KNN statement — succeeds, operator dropped
      [
        [
          { id: 'f1', knnDist: null },
          { id: 'f2', knnDist: null },
        ],
      ],
      // 2. the diagnostic probe
      INFO_TABLE_NO_INDEX,
      // 3. the exact scan
      [[{ id: 'f9', simScore: 0.91 }]],
    ]);
    const errors: string[] = [];
    const rows = await runVectorLeg(
      legArgs(db, { warn: () => {}, error: (m: string) => errors.push(m) }),
    );

    // The garbage is discarded, not scored.
    expect(rows).toEqual([{ id: 'f9', simScore: 0.91 }]);
    expect(rows.map((r) => r.id)).not.toContain('f1');
    // KNN → INFO FOR TABLE → exact scan.
    expect(db.calls).toHaveLength(3);
    expect(db.calls[0]).toContain('<|20,100|>');
    expect(db.calls[1]).toContain('INFO FOR TABLE knowledge_fact');
    expect(db.calls[2]).toContain('vector::similarity::cosine(embedding, $q) AS simScore');
    // Loud: ERROR, not a debug crumb, and it names the fix.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('DROPPED');
    expect(errors[0]).toContain('/v1/admin/maintenance/hnsw');
  });

  it('says "still building" when the index exists but is not ready', async () => {
    const db = fakeDb([
      [[{ id: 'f1', knnDist: null }]],
      INFO_TABLE_WITH_INDEX,
      [{ building: { initial: 16, pending: 0, status: 'indexing' } }],
      [[{ id: 'f9', simScore: 0.5 }]],
    ]);
    const errors: string[] = [];
    await runVectorLeg(legArgs(db, { warn: () => {}, error: (m: string) => errors.push(m) }));
    expect(errors[0]).toContain('still building');
  });

  it('keeps the KNN result when the operator rode the index (one round trip)', async () => {
    const db = fakeDb([[[{ id: 'f1', knnDist: 0.25 }]]]);
    const rows = await runVectorLeg(legArgs(db));
    // COSINE distance → similarity.
    expect(rows).toEqual([{ id: 'f1', simScore: 0.75 }]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).toContain('<|');
  });

  it('leaves an empty KNN result empty — that is not a missing index', async () => {
    const db = fakeDb([[[]]]);
    const rows = await runVectorLeg(legArgs(db));
    expect(rows).toEqual([]);
    // No probe, no scan: an empty tenant must not trigger a full-table
    // cosine walk (a brute scan over 20k × 1024-d OOM-killed the server at
    // 6 GB and 8 GB — roadmap §3 S11).
    expect(db.calls).toHaveLength(1);
  });

  it('is inert when the HNSW flag is off (byte-identical legacy scan)', async () => {
    const db = fakeDb([[[{ id: 'f9', simScore: 0.4 }]]]);
    const rows = await runVectorLeg({
      ...legArgs(db),
      tuning: { ...tuning, hnswEnabled: false },
    });
    expect(rows).toEqual([{ id: 'f9', simScore: 0.4 }]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).not.toContain('<|');
  });

  it('still falls back when the KNN statement throws (the legacy path)', async () => {
    const calls: string[] = [];
    let first = true;
    const db = {
      calls,
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (first) {
          first = false;
          throw new Error('boom');
        }
        return [[{ id: 'f9', simScore: 0.3 }]];
      }),
    };
    const warns: string[] = [];
    const rows = await runVectorLeg(
      legArgs(db as unknown as FakeDb, { warn: (m: string) => warns.push(m) }),
    );
    expect(rows).toEqual([{ id: 'f9', simScore: 0.3 }]);
    expect(warns.join(' ')).toContain('fell back to full scan');
  });
});

describe('coverage dense scan leg — the same defect, the same fallback', () => {
  const request = (db: FakeDb, logger?: object) => ({
    db: db as never,
    table: 'episode_segment' as const,
    projection: 'id, text',
    gates: 'AND userId IS NONE',
    params: { q: [0.1], k: 400 },
    k: 400,
    tuning: { mode: 'hnsw' as const, ef: 400, overfetch: 4 },
    ...(logger ? { logger: logger as never } : {}),
  });

  it('discards the unranked rows and re-runs the brute scan', async () => {
    const db = fakeDb([
      // The bug: a NON-empty result, so the existing `rows.length > 0`
      // guard passed it through with `score: undefined`.
      [
        [
          { id: 's1', knnDist: null },
          { id: 's2', knnDist: null },
        ],
      ],
      [{ events: {}, fields: {}, indexes: {}, lives: {}, tables: {} }],
      [[{ id: 's9', score: 0.8 }]],
    ]);
    const errors: string[] = [];
    const rows = await runDenseScanLeg(
      request(db, { warn: () => {}, error: (m: string) => errors.push(m) }),
    );
    expect(rows).toEqual([{ id: 's9', score: 0.8 }]);
    expect(db.calls[0]).toContain('<|');
    expect(db.calls[2]).toContain('embedding != NONE');
    expect(errors[0]).toContain('segment_embedding_hnsw');
  });
});
