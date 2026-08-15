import { EntityForgetService } from '../src/entities/entity-forget.service';
import { UserForgetService } from '../src/entities/user-forget.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { ConfigService } from '@nestjs/config';

/**
 * Audit W1 (engine-architecture-audit-2026-08.md #13): erasure stopped at
 * L1. The verbatim episodes naming the erased subject stayed readable
 * through both L0 lanes and GET /v1/episodes — and a re-derive
 * RESURRECTED the deleted facts from them. These pin the cascade.
 */
interface Recorded {
  sql: string;
  params?: Record<string, unknown>;
}

function makeDb(rowsFor: (sql: string) => unknown[]): {
  db: { query: (sql: string, p?: Record<string, unknown>) => Promise<unknown> };
  queries: Recorded[];
} {
  const queries: Recorded[] = [];
  return {
    queries,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        return [rowsFor(sql)];
      },
    },
  };
}

describe('entity forget → L0 cascade', () => {
  it('deletes the grounding episodes and the segments quoting them', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('FROM type::record')) return [{ id: 'knowledge_entity:e' }];
      if (sql.includes('SELECT source.episodeIds AS eps'))
        return [
          { eps: ['episode:a', 'episode:b'] },
          { eps: ['episode:b'] }, // duplicate — must dedupe
        ];
      if (sql.includes('SELECT id FROM knowledge_fact'))
        return [{ id: 'knowledge_fact:f1' }];
      if (sql.includes('DELETE episode_segment')) return [{ id: 'seg:1' }];
      if (sql.includes('DELETE episode ')) return [{ id: 'episode:a' }, { id: 'episode:b' }];
      // dbCreate asserts a returned row (tombstone must be observable);
      // its SQL is the generic `CREATE type::table($t) …` form.
      if (sql.includes('CREATE type::table')) return [{ id: 'forgotten_entity:t1' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    } as unknown as SurrealService;
    const config = {
      get: (_k: string, d?: string) => d,
    } as unknown as ConfigService;
    const svc = new EntityForgetService(surreal, config);

    const res = await svc.forget({
      companyId: 'co_x',
      entityIdRaw: 'knowledge_entity:e',
      dto: { reason: 'gdpr' } as never,
      actorKeyHash: 'admin1',
    });

    expect(res.episodesDeleted).toBe(2);
    expect(res.segmentsDeleted).toBe(1);

    const epDelete = queries.find((q) => q.sql.includes('DELETE episode '));
    expect(epDelete).toBeDefined();
    // deduped to the two distinct episodes
    expect((epDelete?.params?.eps as unknown[]).length).toBe(2);

    // Segments must go BEFORE the episodes they reference (dangling links).
    const segIdx = queries.findIndex((q) =>
      q.sql.includes('DELETE episode_segment'),
    );
    const epIdx = queries.findIndex((q) => q.sql.includes('DELETE episode '));
    expect(segIdx).toBeLessThan(epIdx);

    // Grounding episodes must be resolved BEFORE the facts that name them.
    const groundIdx = queries.findIndex((q) =>
      q.sql.includes('SELECT source.episodeIds AS eps'),
    );
    const factDelIdx = queries.findIndex((q) =>
      q.sql.includes('DELETE knowledge_fact'),
    );
    expect(groundIdx).toBeLessThan(factDelIdx);
  });

  it('no grounding episodes → no episode/segment deletes at all', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('FROM type::record')) return [{ id: 'knowledge_entity:e' }];
      if (sql.includes('CREATE type::table'))
        return [{ id: 'forgotten_entity:t1' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    } as unknown as SurrealService;
    const config = {
      get: (_k: string, d?: string) => d,
    } as unknown as ConfigService;
    const res = await new EntityForgetService(surreal, config).forget({
      companyId: 'co_x',
      entityIdRaw: 'knowledge_entity:e',
      dto: { reason: 'gdpr' } as never,
      actorKeyHash: 'admin1',
    });
    expect(res.episodesDeleted).toBe(0);
    expect(res.segmentsDeleted).toBe(0);
    expect(queries.some((q) => q.sql.includes('DELETE episode '))).toBe(false);
  });
});

describe('user forget → segments follow the deleted episodes', () => {
  it('deletes segments by episode reference AND by userId', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('DELETE episode WHERE userId'))
        return [{ id: 'episode:u1a' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) =>
        fn(db),
    } as unknown as SurrealService;
    await new UserForgetService(surreal).forgetUser('co_x', 'u1');

    const byRef = queries.find(
      (q) =>
        q.sql.includes('DELETE episode_segment') &&
        q.sql.includes('CONTAINSANY'),
    );
    const byUser = queries.find(
      (q) =>
        q.sql.includes('DELETE episode_segment') && q.sql.includes('userId'),
    );
    expect(byRef).toBeDefined();
    expect((byRef?.params?.eps as unknown[]).length).toBe(1);
    expect(byUser).toBeDefined();
  });
});
