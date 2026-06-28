/**
 * Unit-test for CompactionService. Mocks SurrealService, ApiKeyService,
 * and the SummaryGenerator to verify retention math, multi-tenant fan-out,
 * error isolation, and the optional summary leg.
 */
import { ConfigService } from '@nestjs/config';
import { CompactionRunnerService } from '../src/compaction/compaction-runner.service';
import type {
  FactToSummarize,
  SummaryGenerator,
} from '../src/compaction/summary-generator';
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
  params?: Record<string, unknown>;
}

interface CandidateRow {
  id: string;
  entityId: string;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence: number;
}

interface TenantSeed {
  rows: CandidateRow[];
  updateError?: Error;
}

function makeFakeSurreal(byTenant: Record<string, TenantSeed>) {
  const calls: Array<{ companyId: string; calls: QueryCall[] }> = [];
  const created: Array<{ companyId: string; payload: Record<string, unknown> }> = [];

  const surreal = {
    async withCompany<T>(companyId: string, fn: (db: unknown) => Promise<T>): Promise<T> {
      const log: QueryCall[] = [];
      const tenant = byTenant[companyId] ?? { rows: [] };
      const fakeDb = {
        async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
          log.push({ sql, params });
          if (sql.includes('SELECT id, entityId, predicate')) {
            return [tenant.rows] as unknown as R;
          }
          if (sql.startsWith('UPDATE')) {
            if (tenant.updateError) throw tenant.updateError;
            return [[]] as unknown as R;
          }
          if (sql.startsWith('CREATE type::table($t)')) {
            // dbCreate helper signature
            const data = params!.d as Record<string, unknown>;
            created.push({ companyId, payload: data });
            return [[{ ...data, id: `synthetic_${created.length}` }]] as unknown as R;
          }
          return [[]] as unknown as R;
        },
      };
      const out = await fn(fakeDb);
      calls.push({ companyId, calls: log });
      return out;
    },
  } as unknown as SurrealService;
  return { surreal, calls, created };
}

function rows(specs: Array<Partial<CandidateRow> & { id: string }>): CandidateRow[] {
  return specs.map((s, i) => ({
    entityId: 'knowledge_entity:e1',
    predicate: 'tier',
    object: `value_${i}`,
    validFrom: `2025-${String(i % 12 + 1).padStart(2, '0')}-01T00:00:00Z`,
    confidence: 0.8,
    ...s,
  }));
}

describe('CompactionService — mark + drop (default mode)', () => {
  it('compacts each tenant once and returns per-tenant counts', async () => {
    const { surreal, calls } = makeFakeSurreal({
      co_a: { rows: rows(Array.from({ length: 12 }, (_, i) => ({ id: `f${i}` }))) },
      co_b: { rows: [] },
      co_c: { rows: rows(Array.from({ length: 5 }, (_, i) => ({ id: `g${i}` }))) },
    });
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig() as unknown as ConfigService,
    );

    const stats = await runner.compactAll(['co_a', 'co_b', 'co_c']);
    expect(stats).toHaveLength(3);
    const byTenant = Object.fromEntries(stats.map((s) => [s.companyId, s]));
    expect(byTenant.co_a.factsCompacted).toBe(12);
    expect(byTenant.co_b.factsCompacted).toBe(0);
    expect(byTenant.co_c.factsCompacted).toBe(5);
    expect(byTenant.co_a.summariesCreated).toBe(0); // summaries off by default
    expect(byTenant.co_a.bytesFreed).toBe(12 * 6 * 1024);

    const calls_b = calls.find((c) => c.companyId === 'co_b')!;
    expect(calls_b.calls.some((c) => c.sql.startsWith('UPDATE'))).toBe(false);

    const calls_a = calls.find((c) => c.companyId === 'co_a')!;
    expect(calls_a.calls.filter((c) => c.sql.startsWith('UPDATE'))).toHaveLength(1);
  });

  it('isolates per-tenant failures', async () => {
    const { surreal } = makeFakeSurreal({
      co_a: { rows: rows([{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }]) },
      co_b: {
        rows: rows([{ id: 'g1' }, { id: 'g2' }]),
        updateError: new Error('surreal exploded'),
      },
      co_c: { rows: rows([{ id: 'h1' }, { id: 'h2' }]) },
    });
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig() as unknown as ConfigService,
    );

    const stats = await runner.compactAll(['co_a', 'co_b', 'co_c']);
    expect(stats.map((s) => s.companyId).sort()).toEqual(['co_a', 'co_c']);
  });

  it('honours COMPACTION_HOT_RETENTION_DAYS env override', async () => {
    const { surreal, calls } = makeFakeSurreal({ co_a: { rows: rows([{ id: 'f1' }]) } });
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_HOT_RETENTION_DAYS: '30' }) as unknown as ConfigService,
    );

    const before = Date.now();
    await runner.compactCompany('co_a');
    const after = Date.now();

    const select = calls[0].calls.find((c) => c.sql.includes('SELECT id, entityId'))!;
    const cutoff = select.params!.cutoff as string;
    const cutoffMs = Date.parse(cutoff);
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - 30 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid retention config at construction', () => {
    const surreal = {} as SurrealService;
    expect(
      () =>
        new CompactionRunnerService(
          surreal,
          new StubConfig({ COMPACTION_HOT_RETENTION_DAYS: '0' }) as unknown as ConfigService,
        ),
    ).toThrow(/positive integer/);
    expect(
      () =>
        new CompactionRunnerService(
          surreal,
          new StubConfig({ COMPACTION_HOT_RETENTION_DAYS: 'abc' }) as unknown as ConfigService,
        ),
    ).toThrow(/positive integer/);
  });
});

describe('CompactionService — summary mode (COMPACTION_SUMMARIES=true)', () => {
  class StubGenerator implements SummaryGenerator {
    public calls: FactToSummarize[][] = [];
    constructor(private readonly text: (g: FactToSummarize[]) => string) {}
    async generate(group: FactToSummarize[]): Promise<string> {
      this.calls.push(group);
      return this.text(group);
    }
  }

  it('creates one summary fact per (entityId, predicate) group of >= 2', async () => {
    const { surreal, calls, created } = makeFakeSurreal({
      co_a: {
        rows: rows([
          { id: 'fact:1', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'gold', validFrom: '2025-01-01T00:00:00Z' },
          { id: 'fact:2', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'platinum', validFrom: '2025-04-01T00:00:00Z' },
          { id: 'fact:3', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'diamond', validFrom: '2025-07-01T00:00:00Z' },
          { id: 'fact:4', entityId: 'knowledge_entity:e2', predicate: 'name', object: 'Anna', validFrom: '2025-01-15T00:00:00Z' },
          // Singleton group — should NOT produce a summary
          { id: 'fact:5', entityId: 'knowledge_entity:e3', predicate: 'lifetime_orders', object: '4', validFrom: '2025-02-01T00:00:00Z' },
        ]),
      },
    });
    const gen = new StubGenerator((g) => `SUMMARY(${g.length}:${g.map((f) => f.object).join(',')})`);

    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_SUMMARIES: 'true' }) as unknown as ConfigService,
      gen,
    );

    const [stats] = await runner.compactAll(['co_a']);
    expect(stats.factsCompacted).toBe(5);
    // Two summaries: tier (3 rows) + name (1 row) — name is singleton, skip
    expect(stats.summariesCreated).toBe(1);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0].map((f) => f.object)).toEqual(['gold', 'platinum', 'diamond']);

    expect(created).toHaveLength(1);
    const summary = created[0].payload as Record<string, unknown>;
    expect(summary.predicate).toBe('summary_tier');
    expect(summary.object).toBe('SUMMARY(3:gold,platinum,diamond)');
    expect((summary.derivedFrom as unknown[]).length).toBe(3);
    expect(summary.validFrom).toBe('2025-01-01T00:00:00Z');
    expect(summary.confidence).toBeCloseTo(0.8, 5);
    expect(summary.status).toBe('active');

    const updates = calls[0].calls.filter((c) => c.sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(1);
  });

  it('skips summary creation when generator returns empty string', async () => {
    const { surreal, created } = makeFakeSurreal({
      co_a: {
        rows: rows([
          { id: 'fact:1', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'gold' },
          { id: 'fact:2', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'platinum' },
        ]),
      },
    });
    const emptyGen: SummaryGenerator = { generate: async () => '' };
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_SUMMARIES: 'true' }) as unknown as ConfigService,
      emptyGen,
    );
    const [stats] = await runner.compactAll(['co_a']);
    expect(stats.factsCompacted).toBe(2);
    expect(stats.summariesCreated).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('does not create summaries when COMPACTION_SUMMARIES is false', async () => {
    const { surreal, created } = makeFakeSurreal({
      co_a: {
        rows: rows([
          { id: 'fact:1', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'gold' },
          { id: 'fact:2', entityId: 'knowledge_entity:e1', predicate: 'tier', object: 'platinum' },
        ]),
      },
    });
    const gen = new StubGenerator(() => 'should-not-run');
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig() as unknown as ConfigService, // default = false
      gen,
    );
    const [stats] = await runner.compactAll(['co_a']);
    expect(stats.factsCompacted).toBe(2);
    expect(stats.summariesCreated).toBe(0);
    expect(gen.calls).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

describe('ConcatSummaryGenerator', () => {
  it('produces a chronological concat with date prefix and predicate', async () => {
    const { ConcatSummaryGenerator } = await import('../src/compaction/summary-generator');
    const gen = new ConcatSummaryGenerator();
    const text = await gen.generate([
      { factId: 'a', predicate: 'tier', object: 'gold', validFrom: '2025-01-15T00:00:00Z', confidence: 0.9 },
      { factId: 'b', predicate: 'tier', object: 'platinum', validFrom: '2025-04-01T00:00:00Z', confidence: 0.95 },
    ]);
    expect(text).toBe('[2025-01-15] tier: gold | [2025-04-01] tier: platinum');
  });

  it('truncates very long output to 8000 chars', async () => {
    const { ConcatSummaryGenerator } = await import('../src/compaction/summary-generator');
    const gen = new ConcatSummaryGenerator();
    const big = 'x'.repeat(10_000);
    const text = await gen.generate([
      { factId: 'a', predicate: 'note', object: big, validFrom: '2025-01-15T00:00:00Z', confidence: 0.9 },
    ]);
    expect(text.length).toBe(8_000);
    expect(text.endsWith('...')).toBe(true);
  });
});
