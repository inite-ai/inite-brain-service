/**
 * Unit-test for CompactionService. Mocks SurrealService, ApiKeyService,
 * and the SummaryGenerator to verify retention math, multi-tenant fan-out,
 * error isolation, and the optional summary leg — plus the evidence-plane
 * episode stamping of compaction AND promotion summaries
 * (PROVENANCE_SUMMARY_EPISODE_STAMP; both runners live in src/compaction).
 */
import { ConfigService } from '@nestjs/config';
import { CompactionRunnerService } from '../src/compaction/compaction-runner.service';
import { PromotionRunnerService } from '../src/compaction/promotion-runner.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { FactToSummarize, SummaryGenerator } from '../src/compaction/summary-generator';
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
  params?: Record<string, unknown> | undefined;
}

interface CandidateRow {
  id: string;
  entityId: string;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil?: string;
  confidence: number;
  /** `source.episodeIds AS eps` — grounding stamp of the member. */
  eps?: string[];
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
    validFrom: `2025-${String((i % 12) + 1).padStart(2, '0')}-01T00:00:00Z`,
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
    expect(byTenant.co_a!.factsCompacted).toBe(12);
    expect(byTenant.co_b!.factsCompacted).toBe(0);
    expect(byTenant.co_c!.factsCompacted).toBe(5);
    expect(byTenant.co_a!.summariesCreated).toBe(0); // summaries off by default
    expect(byTenant.co_a!.bytesFreed).toBe(12 * 6 * 1024);

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

    const select = calls[0]!.calls.find((c) => c.sql.includes('SELECT id, entityId'))!;
    // Date param, not an ISO string — SurrealDB 3.x needs a native
    // datetime (the 2.x `d$cutoff` cast no longer parses).
    const cutoff = select.params!.cutoff as Date;
    expect(cutoff).toBeInstanceOf(Date);
    const cutoffMs = cutoff.getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - 30 * 24 * 60 * 60 * 1000);
  });

  it('honours a per-tenant hotRetentionDays override (COMPACTION_TENANT_OVERRIDES)', async () => {
    const saved = process.env.COMPACTION_TENANT_OVERRIDES;
    process.env.COMPACTION_TENANT_OVERRIDES = JSON.stringify({
      co_a: { hotRetentionDays: 30 },
    });
    try {
      const { surreal, calls } = makeFakeSurreal({
        co_a: { rows: rows([{ id: 'f1' }]) },
        co_b: { rows: rows([{ id: 'g1' }]) },
      });
      const runner = new CompactionRunnerService(
        surreal,
        new StubConfig() as unknown as ConfigService, // process default 90d
      );

      const before = Date.now();
      await runner.compactCompany('co_a');
      await runner.compactCompany('co_b');
      const after = Date.now();

      const cutoffOf = (companyId: string): number => {
        const tenant = calls.find((c) => c.companyId === companyId)!;
        const select = tenant.calls.find((c) => c.sql.includes('SELECT id, entityId'))!;
        return (select.params!.cutoff as Date).getTime();
      };
      // co_a follows its 30d override…
      expect(cutoffOf('co_a')).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
      expect(cutoffOf('co_a')).toBeLessThanOrEqual(after - 30 * 24 * 60 * 60 * 1000);
      // …while co_b keeps the process-global 90d default.
      expect(cutoffOf('co_b')).toBeGreaterThanOrEqual(before - 90 * 24 * 60 * 60 * 1000);
      expect(cutoffOf('co_b')).toBeLessThanOrEqual(after - 90 * 24 * 60 * 60 * 1000);
    } finally {
      if (saved === undefined) delete process.env.COMPACTION_TENANT_OVERRIDES;
      else process.env.COMPACTION_TENANT_OVERRIDES = saved;
    }
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
          {
            id: 'fact:1',
            entityId: 'knowledge_entity:e1',
            predicate: 'tier',
            object: 'gold',
            validFrom: '2025-01-01T00:00:00Z',
          },
          {
            id: 'fact:2',
            entityId: 'knowledge_entity:e1',
            predicate: 'tier',
            object: 'platinum',
            validFrom: '2025-04-01T00:00:00Z',
          },
          {
            id: 'fact:3',
            entityId: 'knowledge_entity:e1',
            predicate: 'tier',
            object: 'diamond',
            validFrom: '2025-07-01T00:00:00Z',
          },
          {
            id: 'fact:4',
            entityId: 'knowledge_entity:e2',
            predicate: 'name',
            object: 'Anna',
            validFrom: '2025-01-15T00:00:00Z',
          },
          // Singleton group — should NOT produce a summary
          {
            id: 'fact:5',
            entityId: 'knowledge_entity:e3',
            predicate: 'lifetime_orders',
            object: '4',
            validFrom: '2025-02-01T00:00:00Z',
          },
        ]),
      },
    });
    const gen = new StubGenerator(
      (g) => `SUMMARY(${g.length}:${g.map((f) => f.object).join(',')})`,
    );

    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_SUMMARIES: 'true' }) as unknown as ConfigService,
      gen,
    );

    const [stats] = await runner.compactAll(['co_a']);
    expect(stats!.factsCompacted).toBe(5);
    // Two summaries: tier (3 rows) + name (1 row) — name is singleton, skip
    expect(stats!.summariesCreated).toBe(1);
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]!.map((f) => f.object)).toEqual(['gold', 'platinum', 'diamond']);

    expect(created).toHaveLength(1);
    const summary = created[0]!.payload as Record<string, unknown>;
    expect(summary.predicate).toBe('summary_tier');
    expect(summary.object).toBe('SUMMARY(3:gold,platinum,diamond)');
    expect((summary.derivedFrom as unknown[]).length).toBe(3);
    expect(summary.validFrom).toBe('2025-01-01T00:00:00Z');
    expect(summary.confidence).toBeCloseTo(0.8, 5);
    expect(summary.status).toBe('active');

    const updates = calls[0]!.calls.filter((c) => c.sql.startsWith('UPDATE'));
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
    expect(stats!.factsCompacted).toBe(2);
    expect(stats!.summariesCreated).toBe(0);
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
    expect(stats!.factsCompacted).toBe(2);
    expect(stats!.summariesCreated).toBe(0);
    expect(gen.calls).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

/**
 * Evidence plane (PROVENANCE_SUMMARY_EPISODE_STAMP): a compaction
 * rollup's source gains the union of its members' grounding stamps
 * (window-deriver idiom — member order, deduped, capped 64). Off
 * (default) the written source deep-equals today's exactly.
 */
describe('CompactionRunnerService — summary episode stamping', () => {
  const saved = process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
  afterEach(() => {
    if (saved === undefined) delete process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
    else process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = saved;
  });

  const stampedRows = () =>
    rows([
      {
        id: 'fact:1',
        predicate: 'tier',
        object: 'gold',
        validFrom: '2025-01-01T00:00:00Z',
        eps: ['episode:e1', 'episode:shared'],
      },
      {
        id: 'fact:2',
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2025-04-01T00:00:00Z',
        eps: ['episode:shared', 'episode:e2'],
      },
    ]);

  const makeRunner = (surreal: SurrealService) =>
    new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_SUMMARIES: 'true' }) as unknown as ConfigService,
      { generate: async () => 'S' },
    );

  it('flag OFF (default): written source deep-equals today’s', async () => {
    delete process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
    const { surreal, created } = makeFakeSurreal({ co_a: { rows: stampedRows() } });
    await makeRunner(surreal).compactAll(['co_a']);
    expect(created).toHaveLength(1);
    expect(created[0]!.payload.source).toEqual({ kind: 'compaction-summary' });
  });

  it('flag ON: source carries the member union — member order, deduped', async () => {
    process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
    const { surreal, created } = makeFakeSurreal({ co_a: { rows: stampedRows() } });
    await makeRunner(surreal).compactAll(['co_a']);
    expect(created).toHaveLength(1);
    expect(created[0]!.payload.source).toEqual({
      kind: 'compaction-summary',
      episodeIds: ['episode:e1', 'episode:shared', 'episode:e2'],
    });
  });

  it('flag ON: members without stamps yield today’s source (no empty key)', async () => {
    process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
    const { surreal, created } = makeFakeSurreal({
      co_a: {
        rows: rows([
          { id: 'fact:1', predicate: 'tier', object: 'gold' },
          { id: 'fact:2', predicate: 'tier', object: 'platinum' },
        ]),
      },
    });
    await makeRunner(surreal).compactAll(['co_a']);
    expect(created[0]!.payload.source).toEqual({ kind: 'compaction-summary' });
  });

  it('the candidate SELECT carries the grounding stamp column', async () => {
    const { surreal, calls } = makeFakeSurreal({ co_a: { rows: [] } });
    await makeRunner(surreal).compactAll(['co_a']);
    const select = calls[0]!.calls.find((c) => c.sql.includes('SELECT id, entityId'))!;
    expect(select.sql).toContain('source.episodeIds AS eps');
  });
});

/**
 * Evidence plane (PROVENANCE_SUMMARY_EPISODE_STAMP) on the promotion
 * runner: the episodic→semantic summary carries the union of the folded
 * members' grounding stamps. Off (default) the written source
 * deep-equals today's `{ kind: 'promotion' }` exactly.
 */
describe('PromotionRunnerService — summary episode stamping', () => {
  const saved = process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
  afterEach(() => {
    if (saved === undefined) delete process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
    else process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = saved;
  });

  interface PromotableSeed {
    id: string;
    object: string;
    validFrom: string;
    eps?: string[];
  }

  function makePromotionStack(seeds: PromotableSeed[]) {
    const calls: QueryCall[] = [];
    const created: Array<Record<string, unknown>> = [];
    const fakeDb = {
      async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
        calls.push({ sql, params });
        if (sql.includes('GROUP BY entityId, predicate, userId')) {
          return [
            [{ entityId: 'knowledge_entity:e1', predicate: 'said', n: seeds.length }],
          ] as unknown as R;
        }
        if (sql.includes('WHERE entityId = $entity AND predicate = $predicate')) {
          return [
            seeds.map((s) => ({
              id: s.id,
              entityId: 'knowledge_entity:e1',
              predicate: 'said',
              object: s.object,
              validFrom: s.validFrom,
              confidence: 0.9,
              ...(s.eps ? { eps: s.eps } : {}),
            })),
          ] as unknown as R;
        }
        if (sql.startsWith('CREATE type::table($t)')) {
          created.push(params!.d as Record<string, unknown>);
          return [[{ id: 'knowledge_fact:summary1' }]] as unknown as R;
        }
        return [[]] as unknown as R;
      },
    };
    const surreal = {
      withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn(fakeDb),
    } as unknown as SurrealService;
    const embedder = { embed: async () => [1, 0] } as unknown as EmbedderService;
    const runner = new PromotionRunnerService(
      surreal,
      new StubConfig({
        COMPACTION_PROMOTION_ENABLED: '1',
        COMPACTION_PROMOTION_MIN_GROUP: '2',
      }) as unknown as ConfigService,
      embedder,
      { generate: async () => 'promoted summary' },
    );
    return { runner, calls, created };
  }

  // 'said' is a seed append_only predicate — the only class promotion folds.
  const SEEDS: PromotableSeed[] = [
    {
      id: 'knowledge_fact:s1',
      object: 'old remark 1',
      validFrom: '2025-01-01T00:00:00Z',
      eps: ['episode:e1', 'episode:shared'],
    },
    {
      id: 'knowledge_fact:s2',
      object: 'old remark 2',
      validFrom: '2025-02-01T00:00:00Z',
      eps: ['episode:shared', 'episode:e2'],
    },
  ];

  it('flag OFF (default): written source deep-equals today’s { kind: promotion }', async () => {
    delete process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
    const { runner, created } = makePromotionStack(SEEDS);
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toEqual({ kind: 'promotion' });
  });

  it('flag ON: source carries the member union — member order, deduped', async () => {
    process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
    const { runner, created } = makePromotionStack(SEEDS);
    await runner.promoteCompany('co_a');
    expect(created[0]!.source).toEqual({
      kind: 'promotion',
      episodeIds: ['episode:e1', 'episode:shared', 'episode:e2'],
    });
  });

  it('flag ON: unstamped members yield today’s source (no empty key)', async () => {
    process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
    const { runner, created } = makePromotionStack(SEEDS.map(({ eps: _eps, ...s }) => s));
    await runner.promoteCompany('co_a');
    expect(created[0]!.source).toEqual({ kind: 'promotion' });
  });

  it('the member SELECT carries the grounding stamp column', async () => {
    const { runner, calls } = makePromotionStack(SEEDS);
    await runner.promoteCompany('co_a');
    const select = calls.find((c) => c.sql.includes('WHERE entityId = $entity'))!;
    expect(select.sql).toContain('source.episodeIds AS eps');
  });
});

/**
 * Typed support graph (Drift-5, PROVENANCE_SUPPORT_EDGES): both summary
 * runners mirror the EXACT derivedFrom array they write as
 * summary-derived_from->member memory_support edges. Off (default) the
 * query log carries NO memory_support statement — byte-identical.
 */
describe('summary runners — derived_from edge mirror (PROVENANCE_SUPPORT_EDGES)', () => {
  const saved = process.env.PROVENANCE_SUPPORT_EDGES;
  afterEach(() => {
    if (saved === undefined) delete process.env.PROVENANCE_SUPPORT_EDGES;
    else process.env.PROVENANCE_SUPPORT_EDGES = saved;
  });

  /** Like makeFakeSurreal, but CREATE returns a knowledge_fact-shaped
   *  id — the mirror's `in` endpoint must pass assertEdgeShape. */
  function makeMirrorSurreal(candidates: CandidateRow[]) {
    const calls: QueryCall[] = [];
    const fakeDb = {
      async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
        calls.push({ sql, params });
        if (sql.includes('GROUP BY entityId, predicate, userId')) {
          return [
            [{ entityId: 'knowledge_entity:e1', predicate: 'said', n: candidates.length }],
          ] as unknown as R;
        }
        if (
          sql.includes('SELECT id, entityId, predicate') ||
          sql.includes('WHERE entityId = $entity AND predicate = $predicate')
        ) {
          return [candidates] as unknown as R;
        }
        if (sql.startsWith('CREATE type::table($t)')) {
          return [[{ ...(params!.d as object), id: 'knowledge_fact:sum1' }]] as unknown as R;
        }
        return [[]] as unknown as R;
      },
    };
    const surreal = {
      withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn(fakeDb),
    } as unknown as SurrealService;
    return { surreal, calls };
  }

  const supportCalls = (calls: QueryCall[]) =>
    calls.filter((c) => c.sql.includes('memory_support'));
  const edgeRows = (call: QueryCall) =>
    (call.params!.rows as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      in: String(r.in),
      out: String(r.out),
    }));

  const COMPACTION_SEEDS = rows([
    { id: 'knowledge_fact:m1', predicate: 'tier', object: 'gold' },
    { id: 'knowledge_fact:m2', predicate: 'tier', object: 'platinum' },
  ]);

  it('compaction, flag OFF (default): no memory_support statement in the log', async () => {
    delete process.env.PROVENANCE_SUPPORT_EDGES;
    const { surreal, calls } = makeMirrorSurreal(COMPACTION_SEEDS);
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_SUMMARIES: 'true' }) as unknown as ConfigService,
      { generate: async () => 'S' },
    );
    await runner.compactAll(['co_a']);
    expect(supportCalls(calls)).toEqual([]);
  });

  it('compaction, flag ON: the mirror equals the derivedFrom array, element for element', async () => {
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { surreal, calls } = makeMirrorSurreal(COMPACTION_SEEDS);
    const runner = new CompactionRunnerService(
      surreal,
      new StubConfig({ COMPACTION_SUMMARIES: 'true' }) as unknown as ConfigService,
      { generate: async () => 'S' },
    );
    await runner.compactAll(['co_a']);
    const inserts = supportCalls(calls);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain('INSERT RELATION IGNORE INTO memory_support');
    expect(edgeRows(inserts[0]!)).toEqual([
      {
        in: 'knowledge_fact:sum1',
        out: 'knowledge_fact:m1',
        kind: 'derived_from',
        writer: 'compaction_runner',
      },
      {
        in: 'knowledge_fact:sum1',
        out: 'knowledge_fact:m2',
        kind: 'derived_from',
        writer: 'compaction_runner',
      },
    ]);
  });

  const promotionRunner = (surreal: SurrealService) =>
    new PromotionRunnerService(
      surreal,
      new StubConfig({
        COMPACTION_PROMOTION_ENABLED: '1',
        COMPACTION_PROMOTION_MIN_GROUP: '2',
      }) as unknown as ConfigService,
      { embed: async () => [1, 0] } as unknown as EmbedderService,
      { generate: async () => 'promoted summary' },
    );

  const PROMOTION_SEEDS = rows([
    { id: 'knowledge_fact:s1', predicate: 'said', object: 'old remark 1' },
    { id: 'knowledge_fact:s2', predicate: 'said', object: 'old remark 2' },
  ]);

  it('promotion, flag OFF (default): no memory_support statement in the log', async () => {
    delete process.env.PROVENANCE_SUPPORT_EDGES;
    const { surreal, calls } = makeMirrorSurreal(PROMOTION_SEEDS);
    await promotionRunner(surreal).promoteCompany('co_a');
    expect(supportCalls(calls)).toEqual([]);
  });

  it('promotion, flag ON: mirror lands after the CREATE, writer promotion_runner', async () => {
    process.env.PROVENANCE_SUPPORT_EDGES = '1';
    const { surreal, calls } = makeMirrorSurreal(PROMOTION_SEEDS);
    await promotionRunner(surreal).promoteCompany('co_a');
    const createIdx = calls.findIndex((c) => c.sql.startsWith('CREATE type::table($t)'));
    const insertIdx = calls.findIndex((c) => c.sql.includes('memory_support'));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(createIdx);
    expect(edgeRows(calls[insertIdx]!)).toEqual([
      {
        in: 'knowledge_fact:sum1',
        out: 'knowledge_fact:s1',
        kind: 'derived_from',
        writer: 'promotion_runner',
      },
      {
        in: 'knowledge_fact:sum1',
        out: 'knowledge_fact:s2',
        kind: 'derived_from',
        writer: 'promotion_runner',
      },
    ]);
  });
});

describe('ConcatSummaryGenerator', () => {
  it('produces a chronological concat with date prefix and predicate', async () => {
    const { ConcatSummaryGenerator } = await import('../src/compaction/summary-generator');
    const gen = new ConcatSummaryGenerator();
    const text = await gen.generate([
      {
        factId: 'a',
        predicate: 'tier',
        object: 'gold',
        validFrom: '2025-01-15T00:00:00Z',
        confidence: 0.9,
      },
      {
        factId: 'b',
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2025-04-01T00:00:00Z',
        confidence: 0.95,
      },
    ]);
    expect(text).toBe('[2025-01-15] tier: gold | [2025-04-01] tier: platinum');
  });

  it('truncates very long output to 8000 chars', async () => {
    const { ConcatSummaryGenerator } = await import('../src/compaction/summary-generator');
    const gen = new ConcatSummaryGenerator();
    const big = 'x'.repeat(10_000);
    const text = await gen.generate([
      {
        factId: 'a',
        predicate: 'note',
        object: big,
        validFrom: '2025-01-15T00:00:00Z',
        confidence: 0.9,
      },
    ]);
    expect(text.length).toBe(8_000);
    expect(text.endsWith('...')).toBe(true);
  });
});
