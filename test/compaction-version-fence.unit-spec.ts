import { CompactionRunnerService } from '../src/compaction/compaction-runner.service';
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { ReadPinService } from '../src/episodes/read-pin.service';
import type { SummaryGenerator } from '../src/compaction/summary-generator';

/**
 * Audit W2 (engine-architecture-audit-2026-08.md #10): compaction was
 * version-BLIND. Under a pinned derived world it flipped that world's
 * facts to status='compacted' (invisible) while writing the replacement
 * summary into the legacy namespace the pinned reader never queries —
 * the memory disappeared from both sides.
 */
function makeRunner(pin: string | null): {
  svc: CompactionRunnerService;
  queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT id, entityId, predicate'))
        return [
          [
            {
              id: 'knowledge_fact:f1',
              entityId: 'knowledge_entity:e1',
              predicate: 'address',
              object: 'Berlin',
              validFrom: new Date('2020-01-01'),
              validUntil: new Date('2020-06-01'),
              confidence: 0.9,
            },
            {
              id: 'knowledge_fact:f2',
              entityId: 'knowledge_entity:e1',
              predicate: 'address',
              object: 'Munich',
              validFrom: new Date('2020-06-02'),
              validUntil: new Date('2020-12-01'),
              confidence: 0.8,
            },
          ],
        ];
      if (sql.includes('CREATE type::table')) return [[{ id: 'knowledge_fact:sum1' }]];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  const config = {
    get: (k: string, d?: string) => (k === 'COMPACTION_HOT_RETENTION_DAYS' ? '90' : d),
  } as unknown as ConfigService;
  const readPin = {
    resolve: async () => pin,
    invalidate: () => undefined,
  } as unknown as ReadPinService;
  const svc = new CompactionRunnerService(
    surreal,
    config,
    { generate: async () => 'lived in Berlin, then Munich' } satisfies SummaryGenerator,
    readPin,
  );
  return { svc, queries };
}

describe('compaction stays inside the tenant live world (W2)', () => {
  const savedEnv = process.env.RETRIEVAL_DERIVED_VERSION;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
    else process.env.RETRIEVAL_DERIVED_VERSION = savedEnv;
  });

  const summaryWrite = (
    queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }>,
  ) =>
    queries.find((q) => q.sql.startsWith('CREATE type::table'))?.params?.d as
      Record<string, unknown> | undefined;

  it('pinned tenant: candidates are fenced to the pin', async () => {
    const { svc, queries } = makeRunner('wd-v3');
    await svc.compactCompany('co_x');
    const select = queries.find((q) => q.sql.includes('SELECT id, entityId, predicate'));
    expect(select?.sql).toContain('AND derivedVersion = $derivedVersion');
    expect(select?.params?.derivedVersion).toBe('wd-v3');
    // The replacement summary lands in the same world as the facts it retires.
    expect(summaryWrite(queries)?.derivedVersion).toBe('wd-v3');
  });

  it('legacy tenant: candidates are fenced to the legacy namespace', async () => {
    delete process.env.RETRIEVAL_DERIVED_VERSION;
    const { svc, queries } = makeRunner(null);
    await svc.compactCompany('co_x');
    const select = queries.find((q) => q.sql.includes('SELECT id, entityId, predicate'));
    expect(select?.sql).toContain('AND derivedVersion IS NONE');
    expect(select?.params?.derivedVersion).toBeUndefined();
    const summary = summaryWrite(queries);
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('derivedVersion');
  });
});
