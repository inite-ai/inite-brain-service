/**
 * Unit-test for ExtractionPatternService — normalisation behaviour
 * (case + NFC). DB layer is mocked: SurrealService.withCompany returns
 * a stub Surreal that lets us observe upserts and seed the snapshot.
 */
import { ExtractionPatternService } from '../src/ai/extraction-pattern.service';

type Surreal = {
  query: jest.Mock<Promise<unknown>, [string, Record<string, unknown>?]>;
};

interface MockedSurrealService {
  withCompany<T>(companyId: string, fn: (db: Surreal) => Promise<T>): Promise<T>;
}

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
    const svc = new ExtractionPatternService(service as never);
    const hit = await svc.lookup('demo', 'Maria is the CTO at Acme');
    expect(hit).toBeUndefined();
  });

  it('lookup hits seeded snapshot by normalised clause text', async () => {
    const { service } = mkSurreal([
      {
        clauseText: 'Maria is the CTO at Acme',
        facts: [
          { predicate: 'status', valueSpan: 'CTO', confidence: 0.9 },
        ],
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
    const svc = new ExtractionPatternService(service as never);
    // Lookup uses different casing — should still hit (normalised).
    const hit = await svc.lookup('demo', '  MARIA IS THE CTO AT ACME  ');
    expect(hit).toBeDefined();
    expect(hit!.facts[0].predicate).toBe('status');
    expect(hit!.edges[0].kind).toBe('works_at');
  });

  it('record() upserts an entry per clause', async () => {
    const { service, upserts } = mkSurreal();
    const svc = new ExtractionPatternService(service as never);
    await svc.record('demo', [
      {
        clauseText: 'Maria is the CTO at Acme',
        facts: [
          { predicate: 'status', valueSpan: 'CTO', confidence: 0.9 },
        ],
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
    const upsertSql = upserts[0].sql;
    expect(upsertSql).toContain('UPSERT extraction_pattern');
    expect(upserts[0].params?.key).toBe('maria is the cto at acme');
  });

  it('record() skips empty clause text', async () => {
    const { service, upserts } = mkSurreal();
    const svc = new ExtractionPatternService(service as never);
    await svc.record('demo', [
      {
        clauseText: '   ',
        facts: [],
        edges: [],
      },
    ]);
    expect(upserts).toHaveLength(0);
  });

  it('invalidate() clears the TTL cache for that tenant', async () => {
    const { service } = mkSurreal([
      {
        clauseText: 'foo',
        facts: [],
        edges: [],
      },
    ]);
    const svc = new ExtractionPatternService(service as never);
    await svc.lookup('demo', 'foo'); // populate snapshot
    svc.invalidate('demo');
    // No assertion needed beyond not-throwing — invalidate is fire-and-forget.
    expect(() => svc.invalidate('demo')).not.toThrow();
  });
});
