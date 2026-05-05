/**
 * Unit-test for CompactionService. Mocks SurrealService and ApiKeyService
 * to verify retention math, multi-tenant fan-out, and error isolation.
 */
import { ConfigService } from '@nestjs/config';
import { CompactionService } from '../src/compaction/compaction.service';
import type { ApiKeyService } from '../src/auth/api-key.service';
import type { SurrealService } from '../src/db/surreal.service';

class StubConfig {
  constructor(private readonly map: Record<string, string> = {}) {}
  get<T = string>(key: string, fallback?: T): T {
    return (this.map[key] as unknown as T) ?? (fallback as T);
  }
  getOrThrow<T = string>(key: string): T {
    const v = this.map[key];
    if (v === undefined) throw new Error(`missing ${key}`);
    return v as unknown as T;
  }
}

interface QueryCall {
  sql: string;
  params: Record<string, unknown> | undefined;
}

function makeFakeSurreal(byTenant: Record<string, { count: number; updateError?: Error }>) {
  const calls: Array<{ companyId: string; calls: QueryCall[] }> = [];
  const surreal = {
    async withCompany<T>(companyId: string, fn: (db: unknown) => Promise<T>): Promise<T> {
      const log: QueryCall[] = [];
      const tenant = byTenant[companyId];
      const fakeDb = {
        async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
          log.push({ sql, params });
          if (sql.startsWith('SELECT count()')) {
            return [[{ count: tenant?.count ?? 0 }]] as unknown as R;
          }
          if (sql.startsWith('UPDATE')) {
            if (tenant?.updateError) throw tenant.updateError;
            return [[]] as unknown as R;
          }
          return [[]] as unknown as R;
        },
      };
      const out = await fn(fakeDb);
      calls.push({ companyId, calls: log });
      return out;
    },
  } as unknown as SurrealService;
  return { surreal, calls };
}

function makeApiKeys(companyIds: string[]): ApiKeyService {
  return {
    knownCompanyIds: () => companyIds,
  } as unknown as ApiKeyService;
}

describe('CompactionService', () => {
  it('compacts each tenant once and returns per-tenant counts', async () => {
    const { surreal, calls } = makeFakeSurreal({
      co_a: { count: 12 },
      co_b: { count: 0 },
      co_c: { count: 5 },
    });
    const apiKeys = makeApiKeys(['co_a', 'co_b', 'co_c']);
    const service = new CompactionService(
      surreal,
      apiKeys,
      new StubConfig() as unknown as ConfigService,
    );

    const stats = await service.compactAll();

    expect(stats).toHaveLength(3);
    const byTenant = Object.fromEntries(stats.map((s) => [s.companyId, s]));
    expect(byTenant.co_a.factsCompacted).toBe(12);
    expect(byTenant.co_b.factsCompacted).toBe(0);
    expect(byTenant.co_c.factsCompacted).toBe(5);

    // Bytes-freed estimate: 6 KiB per fact
    expect(byTenant.co_a.bytesFreed).toBe(12 * 6 * 1024);
    expect(byTenant.co_b.bytesFreed).toBe(0);

    // Tenant with zero matches must NOT issue an UPDATE
    const calls_b = calls.find((c) => c.companyId === 'co_b')!;
    expect(calls_b.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);

    // Tenant with matches issues exactly one UPDATE
    const calls_a = calls.find((c) => c.companyId === 'co_a')!;
    expect(calls_a.calls.filter((c) => c.sql.startsWith('UPDATE'))).toHaveLength(1);
  });

  it('isolates per-tenant failures — one bad tenant does not abort the rest', async () => {
    const { surreal } = makeFakeSurreal({
      co_a: { count: 3 },
      co_b: { count: 7, updateError: new Error('surreal exploded') },
      co_c: { count: 4 },
    });
    const service = new CompactionService(
      surreal,
      makeApiKeys(['co_a', 'co_b', 'co_c']),
      new StubConfig() as unknown as ConfigService,
    );

    const stats = await service.compactAll();
    // co_b's compaction threw; the result list must still include co_a + co_c
    expect(stats.map((s) => s.companyId).sort()).toEqual(['co_a', 'co_c']);
  });

  it('honours COMPACTION_HOT_RETENTION_DAYS env override', async () => {
    const { surreal, calls } = makeFakeSurreal({ co_a: { count: 1 } });
    const service = new CompactionService(
      surreal,
      makeApiKeys(['co_a']),
      new StubConfig({
        COMPACTION_HOT_RETENTION_DAYS: '30',
      }) as unknown as ConfigService,
    );

    const before = Date.now();
    await service.compactCompany('co_a');
    const after = Date.now();

    const cutoff = calls[0].calls[0].params!.cutoff as string;
    const cutoffMs = Date.parse(cutoff);
    const expectedMin = before - 30 * 24 * 60 * 60 * 1000;
    const expectedMax = after - 30 * 24 * 60 * 60 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoffMs).toBeLessThanOrEqual(expectedMax);
  });

  it('rejects invalid retention config at construction', () => {
    const surreal = {} as SurrealService;
    const apiKeys = makeApiKeys([]);
    expect(
      () =>
        new CompactionService(
          surreal,
          apiKeys,
          new StubConfig({
            COMPACTION_HOT_RETENTION_DAYS: '0',
          }) as unknown as ConfigService,
        ),
    ).toThrow(/positive integer/);
    expect(
      () =>
        new CompactionService(
          surreal,
          apiKeys,
          new StubConfig({
            COMPACTION_HOT_RETENTION_DAYS: 'abc',
          }) as unknown as ConfigService,
        ),
    ).toThrow(/positive integer/);
  });

  it('passes cutoff as ISO string to Surreal d-prefixed param', async () => {
    const { surreal, calls } = makeFakeSurreal({ co_a: { count: 2 } });
    const service = new CompactionService(
      surreal,
      makeApiKeys(['co_a']),
      new StubConfig() as unknown as ConfigService,
    );

    await service.compactCompany('co_a');
    const select = calls[0].calls.find((c) => c.sql.includes('SELECT count()'))!;
    expect(select.sql).toContain('d$cutoff');
    expect(typeof select.params!.cutoff).toBe('string');
    expect(select.params!.cutoff as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
