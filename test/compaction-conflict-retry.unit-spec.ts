/**
 * The compaction pass writes rows the serving path writes too (the
 * vector-corpus repair, usage stamps). A commit-time conflict used to abort
 * the pass: the e2e caught it as "Transaction conflict: Resource busy" on
 * the mark, and a conflict between two summary CREATEs left summaries
 * written and originals unmarked, so the next run summarised them again.
 * Both writes now retry the conflict class; anything else still throws.
 */
import type { ConfigService } from '@nestjs/config';
import { CompactionRunnerService } from '../src/compaction/compaction-runner.service';
import type { SurrealService } from '../src/db/surreal.service';

const CONFLICT = 'Transaction conflict: Resource busy. This transaction can be retried';

function makeRunner(failures: { update?: number; create?: number; updateError?: string }) {
  const left = { update: failures.update ?? 0, create: failures.create ?? 0 };
  const writes = { updates: 0, creates: 0 };
  const db = {
    query: async (sql: string) => {
      if (sql.includes('SELECT id, entityId, predicate')) {
        return [
          [
            {
              id: 'knowledge_fact:a',
              entityId: 'knowledge_entity:e',
              predicate: 'queue',
              object: 'redis',
              validFrom: '2024-01-01T00:00:00Z',
              validUntil: '2024-02-01T00:00:00Z',
              confidence: 0.9,
            },
            {
              id: 'knowledge_fact:b',
              entityId: 'knowledge_entity:e',
              predicate: 'queue',
              object: 'kafka',
              validFrom: '2024-02-01T00:00:00Z',
              validUntil: '2024-03-01T00:00:00Z',
              confidence: 0.8,
            },
          ],
        ];
      }
      if (sql.startsWith('CREATE type::table')) {
        if (left.create > 0) {
          left.create--;
          throw new Error(CONFLICT);
        }
        writes.creates++;
        return [[{ id: 'knowledge_fact:sum' }]];
      }
      if (sql.includes('UPDATE knowledge_fact')) {
        if (failures.updateError) throw new Error(failures.updateError);
        if (left.update > 0) {
          left.update--;
          throw new Error(CONFLICT);
        }
        writes.updates++;
        return [[]];
      }
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  const env: Record<string, string> = {
    COMPACTION_HOT_RETENTION_DAYS: '90',
    COMPACTION_SUMMARIES: '1',
  };
  const config = { get: (k: string, d?: string) => env[k] ?? d } as unknown as ConfigService;
  const runner = new CompactionRunnerService(surreal, config, {
    generate: async () => 'redis, then kafka',
  });
  return { runner, writes };
}

describe('compaction retries a commit-time conflict instead of aborting the pass', () => {
  it('a conflicted mark retries and the pass reports what it compacted', async () => {
    const { runner, writes } = makeRunner({ update: 2 });
    const stats = await runner.compactCompany('co_x');
    expect(stats.factsCompacted).toBe(2);
    expect(writes.updates).toBe(1);
  });

  it('a conflicted summary CREATE retries once and writes exactly one summary', async () => {
    const { runner, writes } = makeRunner({ create: 1 });
    const stats = await runner.compactCompany('co_x');
    expect(stats.summariesCreated).toBe(1);
    expect(writes.creates).toBe(1);
    expect(writes.updates).toBe(1);
  });

  it('a failure that is not a conflict still throws', async () => {
    const { runner } = makeRunner({ updateError: 'Parse error: unexpected token' });
    await expect(runner.compactCompany('co_x')).rejects.toThrow('Parse error');
  });
});
