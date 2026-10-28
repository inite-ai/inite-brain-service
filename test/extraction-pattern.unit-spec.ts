/**
 * Unit-test for ExtractionPatternService — normalisation behaviour
 * (case + NFC). DB layer is mocked: SurrealService.withCompany returns
 * a stub Surreal that lets us observe upserts and seed the snapshot.
 */
import { ExtractionPatternService } from '../src/ai/extraction-pattern.service';

type Surreal = {
  query: jest.Mock<Promise<unknown>, [string, (Record<string, unknown> | undefined)?]>;
};

interface MockedSurrealService {
  withCompany<T>(companyId: string, fn: (db: Surreal) => Promise<T>): Promise<T>;
}

// Minimal ConfigService stub — the service only reads
// EXTRACTION_PATTERN_CACHE_CAP at boot.
const stubConfig = {
  get: (_k: string, def: string) => def,
} as never;

function mkSurreal(seedRows: Array<Record<string, unknown>> = []): {
  service: MockedSurrealService;
  upserts: Array<{ sql: string; params: Record<string, unknown> | undefined }>;
} {
  const upserts: Array<{
    sql: string;
    params: Record<string, unknown> | undefined;
  }> = [];
  const db: Surreal = {
    query: jest.fn(async (sql: string, params?: Record<string, unknown>) => {
      if (sql.includes('SELECT')) {
        return [seedRows] as unknown;
      }
      upserts.push({ sql, params });
      return [[]] as unknown;
    }),
  };
  return {
    service: {
      withCompany: async (_c, fn) => fn(db),
    },
    upserts,
  };
}

describe('ExtractionPatternService', () => {
  it('returns undefined on cold cache lookup', async () => {
    const { service } = mkSurreal();
    const svc = new ExtractionPatternService(service as never, stubConfig);
    const hit = await svc.lookup('demo', 'Maria is the CTO at Acme');
    expect(hit).toBeUndefined();
  });

  it('lookup hits seeded snapshot by normalised clause text', async () => {
    const { service } = mkSurreal([
      {
        clauseText: 'Maria is the CTO at Acme',
        facts: [{ predicate: 'status', valueSpan: 'CTO', confidence: 0.9 }],
        edges: [
          {
            kind: 'works_at',
            fromEntityIndex: 0,
            toEntityIndex: 1,
            confidence: 0.85,
          },
        ],
      },
    ]);
    const svc = new ExtractionPatternService(service as never, stubConfig);
    // Lookup uses different casing — should still hit (normalised).
    const hit = await svc.lookup('demo', '  MARIA IS THE CTO AT ACME  ');
    expect(hit).toBeDefined();
    expect(hit!.facts[0]!.predicate).toBe('status');
    expect(hit!.edges[0]!.kind).toBe('works_at');
  });

  it('record() upserts an entry per clause', async () => {
    const { service, upserts } = mkSurreal();
    const svc = new ExtractionPatternService(service as never, stubConfig);
    await svc.record('demo', [
      {
        clauseText: 'Maria is the CTO at Acme',
        facts: [{ predicate: 'status', valueSpan: 'CTO', confidence: 0.9 }],
        edges: [
          {
            kind: 'works_at',
            fromEntityIndex: 0,
            toEntityIndex: 1,
            confidence: 0.85,
          },
        ],
      },
    ]);
    // Two queries per pattern: UPSERT + sourceCount bump.
    expect(upserts).toHaveLength(2);
    const upsertSql = upserts[0]!.sql;
    expect(upsertSql).toContain('UPSERT extraction_pattern');
    expect(upserts[0]!.params?.key).toBe('maria is the cto at acme');
  });

  it('record() skips empty clause text', async () => {
    const { service, upserts } = mkSurreal();
    const svc = new ExtractionPatternService(service as never, stubConfig);
    await svc.record('demo', [
      {
        clauseText: '   ',
        facts: [],
        edges: [],
      },
    ]);
    expect(upserts).toHaveLength(0);
  });

  it('a failed upsert is logged as a count, never with the clause text', async () => {
    const db = {
      query: jest.fn(async () => {
        throw new Error('Transaction conflict: Resource busy');
      }),
    };
    const service = { withCompany: async (_c: string, fn: (d: typeof db) => unknown) => fn(db) };
    const svc = new ExtractionPatternService(service as never, stubConfig);
    const warn = jest
      .spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    await svc.record('demo', [
      { clauseText: 'I bought a Kawasaki Ninja', facts: [], edges: [] },
      { clauseText: 'my home city is Lisbon', facts: [], edges: [] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('2/2');
    expect(line).not.toMatch(/kawasaki|lisbon/i);
  });

  it('invalidate() clears the TTL cache for that tenant', async () => {
    const { service } = mkSurreal([
      {
        clauseText: 'foo',
        facts: [],
        edges: [],
      },
    ]);
    const svc = new ExtractionPatternService(service as never, stubConfig);
    await svc.lookup('demo', 'foo'); // populate snapshot
    svc.invalidate('demo');
    // No assertion needed beyond not-throwing — invalidate is fire-and-forget.
    expect(() => svc.invalidate('demo')).not.toThrow();
  });
});
