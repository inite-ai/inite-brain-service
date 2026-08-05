import { CompactionRunnerService } from '../src/compaction/compaction-runner.service';
import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { ReadPinService } from '../src/episodes/read-pin.service';

/**
 * Audit W2 (engine-architecture-audit-2026-08.md #10): compaction was
 * version-BLIND. Under a pinned derived world it flipped that world's
 * facts to status='compacted' (invisible) while writing the replacement
 * summary into the legacy namespace the pinned reader never queries —
 * the memory disappeared from both sides.
 */
function makeRunner(pin: string | null): {
  svc: CompactionRunnerService;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
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
      if (sql.includes('CREATE type::table'))
        return [[{ id: 'knowledge_fact:sum1' }]];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
      fn(db),
  } as unknown as SurrealService;
  const config = {
    get: (k: string, d?: string) =>
      k === 'COMPACTION_HOT_RETENTION_DAYS' ? '90' : d,
  } as unknown as ConfigService;
  const readPin = {
    resolve: async () => pin,
    invalidate: () => undefined,
  } as unknown as ReadPinService;
  const svc = new CompactionRunnerService(
    surreal,
    config,
    { summarize: async () => 'lived in Berlin, then Munich' } as never,
    readPin,
  );
  return { svc, queries };
}

describe('compaction stays inside the tenant live world (W2)', () => {
  const savedEnv = process.env.RETRIEVAL_DERIVED_VERSION;
  const savedSummaries = process.env.COMPACTION_SUMMARIES_ENABLED;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RETRIEVAL_DERIVED_VERSION;
    else process.env.RETRIEVAL_DERIVED_VERSION = savedEnv;
    if (savedSummaries === undefined)
      delete process.env.COMPACTION_SUMMARIES_ENABLED;
    else process.env.COMPACTION_SUMMARIES_ENABLED = savedSummaries;
  });

  it('pinned tenant: candidates are fenced to the pin', async () => {
    const { svc, queries } = makeRunner('wd-v3');
    await svc.compactCompany('co_x');
    const select = queries.find((q) =>
      q.sql.includes('SELECT id, entityId, predicate'),
    );
    expect(select?.sql).toContain('AND derivedVersion = $derivedVersion');
    expect(select?.params?.derivedVersion).toBe('wd-v3');
  });

  it('legacy tenant: candidates are fenced to the legacy namespace', async () => {
    delete process.env.RETRIEVAL_DERIVED_VERSION;
    const { svc, queries } = makeRunner(null);
    await svc.compactCompany('co_x');
    const select = queries.find((q) =>
      q.sql.includes('SELECT id, entityId, predicate'),
    );
    expect(select?.sql).toContain('AND derivedVersion IS NONE');
    expect(select?.params?.derivedVersion).toBeUndefined();
  });
});
