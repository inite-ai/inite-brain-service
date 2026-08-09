import { runDenseScanLeg, BRUTE_ONLY } from '../src/synthesize/scan-leg';
import {
  resolveRetrievalProfile,
  resolveRetrievalProfileFor,
} from '../src/search/retrieval-profile';

/**
 * V11 §5 scale gate — the shared dense leg of the coverage scan lanes.
 * The contracts under test: 'brute' emits the legacy exact scan;
 * 'hnsw' emits the approximate KNN with the gate tail intact and the
 * overfetch/ef arithmetic applied; any error OR an empty post-filter
 * pool falls back to the brute scan (gate starvation must not empty a
 * coverage record).
 */

interface FakeDb {
  query: jest.Mock;
  calls: string[];
}

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

const GATES = "AND piiClass IS NONE AND userId IS NONE";

function legRequest(db: FakeDb, tuning = BRUTE_ONLY) {
  return {
    db: db as unknown as Parameters<typeof runDenseScanLeg>[0]['db'],
    table: 'episode_segment' as const,
    projection: 'id, text, occurredAt',
    gates: GATES,
    params: { q: [0.1, 0.2], k: 400 },
    k: 400,
    tuning,
  };
}

describe('runDenseScanLeg', () => {
  it("brute mode emits the legacy exact scan (no KNN operator)", async () => {
    const db = fakeDb([[[{ id: 's1' }]]]);
    const rows = await runDenseScanLeg(legRequest(db));
    expect(rows).toEqual([{ id: 's1' }]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]).toContain('embedding != NONE');
    expect(db.calls[0]).not.toContain('<|');
    expect(db.calls[0]).toContain(GATES);
    expect(db.calls[0]).toContain('ORDER BY score DESC');
  });

  it('hnsw mode emits the KNN operator with overfetch and the gates intact', async () => {
    const db = fakeDb([[[{ id: 's1' }]]]);
    const rows = await runDenseScanLeg(
      legRequest(db, { mode: 'hnsw', ef: 400, overfetch: 4 }),
    );
    expect(rows).toEqual([{ id: 's1' }]);
    expect(db.calls).toHaveLength(1);
    // k=400 × overfetch 4 = 1600; ef clamps up to kOver.
    expect(db.calls[0]).toContain('embedding <|1600,1600|> $q');
    expect(db.calls[0]).toContain(GATES);
    expect(db.calls[0]).not.toContain('embedding != NONE');
  });

  it('ef above the overfetched k survives the clamp', async () => {
    const db = fakeDb([[[{ id: 's1' }]]]);
    await runDenseScanLeg(
      legRequest(db, { mode: 'hnsw', ef: 5000, overfetch: 4 }),
    );
    expect(db.calls[0]).toContain('<|1600,5000|>');
  });

  it('caps the KNN candidate walk at 4000', async () => {
    const db = fakeDb([[[{ id: 's1' }]]]);
    await runDenseScanLeg(
      legRequest(db, { mode: 'hnsw', ef: 400, overfetch: 100 }),
    );
    expect(db.calls[0]).toContain('<|4000,4000|>');
  });

  it('falls back to the brute scan when the KNN query throws', async () => {
    const calls: string[] = [];
    let first = true;
    const db = {
      calls,
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (first) {
          first = false;
          throw new Error('no index for this tenant');
        }
        return [[{ id: 'brute-row' }]];
      }),
    };
    const warns: string[] = [];
    const rows = await runDenseScanLeg({
      ...legRequest(db as unknown as FakeDb, {
        mode: 'hnsw',
        ef: 400,
        overfetch: 4,
      }),
      logger: { warn: (m: string) => warns.push(m) },
    });
    expect(rows).toEqual([{ id: 'brute-row' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('<|');
    expect(calls[1]).toContain('embedding != NONE');
    expect(warns.join(' ')).toContain('falling back to full scan');
  });

  it('falls back to the brute scan on an empty post-filter pool', async () => {
    const db = fakeDb([[[]], [[{ id: 'brute-row' }]]]);
    const warns: string[] = [];
    const rows = await runDenseScanLeg({
      ...legRequest(db, { mode: 'hnsw', ef: 400, overfetch: 4 }),
      logger: { warn: (m: string) => warns.push(m) },
    });
    expect(rows).toEqual([{ id: 'brute-row' }]);
    expect(db.calls).toHaveLength(2);
    expect(warns.join(' ')).toContain('empty after gates');
  });
});

describe('coverageScanMode profile point', () => {
  it('defaults to brute with ef 400 / overfetch 4', () => {
    const p = resolveRetrievalProfile({} as NodeJS.ProcessEnv);
    expect(p.coverageScanMode).toBe('brute');
    expect(p.scanHnswEf).toBe(400);
    expect(p.scanHnswOverfetch).toBe(4);
  });

  it('round-trips from env; garbage rejects to brute', () => {
    const p = resolveRetrievalProfile({
      RETRIEVAL_COVERAGE_SCAN_MODE: 'hnsw',
      RETRIEVAL_SCAN_HNSW_EF: '800',
      RETRIEVAL_SCAN_HNSW_OVERFETCH: '2',
    } as NodeJS.ProcessEnv);
    expect(p.coverageScanMode).toBe('hnsw');
    expect(p.scanHnswEf).toBe(800);
    expect(p.scanHnswOverfetch).toBe(2);
    expect(
      resolveRetrievalProfile({
        RETRIEVAL_COVERAGE_SCAN_MODE: 'faiss',
      } as NodeJS.ProcessEnv).coverageScanMode,
    ).toBe('brute');
  });

  it('overlays per tenant (the one-big-tenant rollout control)', () => {
    const env = {
      RETRIEVAL_PROFILE_OVERRIDES: JSON.stringify({
        bigco: { coverageScanMode: 'hnsw', scanHnswEf: 1600, scanHnswOverfetch: 8 },
      }),
    } as NodeJS.ProcessEnv;
    const big = resolveRetrievalProfileFor('bigco', env);
    expect(big.coverageScanMode).toBe('hnsw');
    expect(big.scanHnswEf).toBe(1600);
    expect(big.scanHnswOverfetch).toBe(8);
    const other = resolveRetrievalProfileFor('other', env);
    expect(other.coverageScanMode).toBe('brute');
  });
});
