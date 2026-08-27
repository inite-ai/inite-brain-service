import { SegmentBackfillService } from '../src/admin/segment-backfill.service';
import type { SurrealService } from '../src/db/surreal.service';

/**
 * 0117 backfill (POST /v1/admin/maintenance/segments/backfill-user-ids):
 * pages on `userIds IS NONE` (plain option-field WHERE — the safe
 * planner shape), resolves member episodes by EXPLICIT ids, computes the
 * sorted member set in TS, and updates STRICTLY by primary key — never
 * an UPDATE ... WHERE (the 3.2.4 planner silently no-ops WHEREs through
 * record links / compound-index-covered fields). Dangling refs are
 * skipped + counted and stay hidden under the fence (fail-closed).
 */
interface Recorded {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

function makeService(rowsFor: (sql: string, calls: number) => unknown): {
  svc: SegmentBackfillService;
  queries: Recorded[];
} {
  const queries: Recorded[] = [];
  let pageCalls = 0;
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes('WHERE userIds IS NONE LIMIT')) pageCalls += 1;
      return [rowsFor(sql, pageCalls)];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  return { svc: new SegmentBackfillService(surreal), queries };
}

describe('segment userIds backfill (0117)', () => {
  it('stamps sorted sets by primary key, skips dangling refs, counts remaining', async () => {
    const { svc, queries } = makeService((sql) => {
      if (sql.includes('WHERE userIds IS NONE LIMIT'))
        return [
          { id: 'episode_segment:s1', episodeIds: ['episode:a', 'episode:b'] },
          { id: 'episode_segment:s2', episodeIds: ['episode:c'] },
          { id: 'episode_segment:s3', episodeIds: ['episode:x'] }, // dangling
        ];
      if (sql.includes('SELECT id, userId FROM $eps'))
        return [
          { id: 'episode:a', userId: 'u2' },
          { id: 'episode:b', userId: 'u1' },
          { id: 'episode:c' }, // tenant-global turn: no userId
        ];
      if (sql.includes('GROUP ALL')) return [{ n: 1 }];
      return [];
    });
    const res = await svc.backfillUserIds('co_x');
    expect(res).toEqual({ scanned: 3, updated: 2, remaining: 1, skippedDangling: 1 });

    const updates = queries.filter((q) => q.sql.includes('UPDATE'));
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      // Primary-key addressed, NEVER a WHERE (3.2.4 planner idiom).
      expect(u.sql).toBe('UPDATE $id SET userIds = $set');
      expect(u.sql).not.toContain('WHERE');
    }
    // Sorted member set for the mixed segment; [] for the global one.
    expect(updates[0]!.params?.set).toEqual(['u1', 'u2']);
    expect(String(updates[0]!.params?.id)).toBe('episode_segment:s1');
    expect(updates[1]!.params?.set).toEqual([]);
    // The dangling row got NO update (it stays fail-closed hidden).
    expect(updates.some((u) => String(u.params?.id) === 'episode_segment:s3')).toBe(false);
  });

  it('terminates when a page brings nothing new (all-dangling head cannot spin)', async () => {
    const { svc, queries } = makeService((sql) => {
      if (sql.includes('WHERE userIds IS NONE LIMIT'))
        // Same dangling row forever — the seen-set must break the loop.
        return Array.from({ length: 200 }, (_, i) => ({
          id: `episode_segment:d${i}`,
          episodeIds: ['episode:gone'],
        }));
      if (sql.includes('SELECT id, userId FROM $eps')) return [];
      if (sql.includes('GROUP ALL')) return [{ n: 200 }];
      return [];
    });
    const res = await svc.backfillUserIds('co_x', { maxRows: 1000 });
    expect(res.updated).toBe(0);
    expect(res.skippedDangling).toBe(200);
    expect(res.remaining).toBe(200);
    // Exactly two page fetches: the first processes (and skips) all 200,
    // the second returns only seen rows and breaks.
    expect(queries.filter((q) => q.sql.includes('WHERE userIds IS NONE LIMIT'))).toHaveLength(2);
  });

  it('respects the maxRows budget', async () => {
    let served = 0;
    const { svc } = makeService((sql) => {
      if (sql.includes('WHERE userIds IS NONE LIMIT')) {
        const page = Array.from({ length: 100 }, (_, i) => ({
          id: `episode_segment:p${served + i}`,
          episodeIds: [],
        }));
        served += 100;
        return page;
      }
      if (sql.includes('GROUP ALL')) return [{ n: 0 }];
      return [];
    });
    const res = await svc.backfillUserIds('co_x', { maxRows: 100 });
    expect(res.scanned).toBe(100);
    expect(res.updated).toBe(100); // empty episodeIds → set [] (purely global)
  });
});
