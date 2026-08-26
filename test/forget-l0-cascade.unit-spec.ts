import { readFileSync } from 'fs';
import { join } from 'path';
import { EntityForgetService } from '../src/entities/entity-forget.service';
import { UserForgetService } from '../src/entities/user-forget.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { ConfigService } from '@nestjs/config';

/**
 * Audit W1 (engine-architecture-audit-2026-08.md #13): erasure stopped at
 * L1. The verbatim episodes naming the erased subject stayed readable
 * through both L0 lanes and GET /v1/episodes — and a re-derive
 * RESURRECTED the deleted facts from them. These pin the cascade.
 *
 * R4 audit: the erase now runs inside ONE client transaction (all the
 * mutations land in a single BEGIN/COMMIT via `runTransaction`, so the
 * write-side is one recorded `db.query('BEGIN TRANSACTION; …')` call, not
 * a sequence of independent DELETEs). These tests pin the cascade AND the
 * atomic + idempotent contract.
 */
interface Recorded {
  sql: string;
  params?: Record<string, unknown> | undefined;
}

function makeDb(rowsFor: (sql: string) => unknown): {
  db: { query: (sql: string, p?: Record<string, unknown>) => Promise<unknown> };
  queries: Recorded[];
} {
  const queries: Recorded[] = [];
  return {
    queries,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => {
        queries.push({ sql, params });
        // runTransaction takes the last-1 (or last) slot of the returned
        // array; every other caller (queryRows/queryFirst) reads slot 0 as
        // its row array. Wrapping rowsFor(sql) in a single-element array
        // serves both: slot 0 is the value, and for the tx that value is
        // the trailing RETURN object.
        return [rowsFor(sql)];
      },
    },
  };
}

const cfg = () =>
  ({
    get: (_k: string, d?: string) => d,
  }) as unknown as ConfigService;

const txQuery = (queries: Recorded[]) => queries.find((q) => q.sql.includes('BEGIN TRANSACTION'));

describe('entity forget → atomic L0 cascade', () => {
  it('erases the entity + L0 in one transaction; segments precede episodes; grounding precedes facts', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('BEGIN TRANSACTION'))
        return {
          auditEventsDeleted: 0,
          episodesDeleted: 2,
          segmentsDeleted: 1,
          tombstone: { id: 'forgotten_entity:t1', entityIdHash: 'hmac:x' },
        };
      if (sql.includes('FROM forgotten_entity')) return []; // no prior tombstone
      if (sql.includes('FROM type::record')) return [{ id: 'knowledge_entity:e' }];
      if (sql.includes('SELECT source.episodeIds AS eps'))
        return [
          { eps: ['episode:a', 'episode:b'] },
          { eps: ['episode:b'] }, // duplicate — must dedupe
        ];
      if (sql.includes('SELECT id FROM knowledge_fact')) return [{ id: 'knowledge_fact:f1' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    const svc = new EntityForgetService(surreal, cfg());

    const res = await svc.forget({
      companyId: 'co_x',
      entityIdRaw: 'knowledge_entity:e',
      dto: { reason: 'gdpr_request', requestId: 'req-1' } as never,
      actorKeyHash: 'admin1',
    });

    expect(res.factsDeleted).toBe(1);
    expect(res.episodesDeleted).toBe(2);
    expect(res.segmentsDeleted).toBe(1);

    // The whole write-side is ONE transaction.
    const tx = txQuery(queries);
    expect(tx).toBeDefined();
    // Deduped to the two distinct episodes, bound as record refs.
    expect((tx?.params?.eps as unknown[]).length).toBe(2);

    // Segments must go BEFORE the episodes they reference (dangling links).
    const txSql = tx!.sql;
    expect(txSql.indexOf('DELETE episode_segment')).toBeLessThan(
      txSql.indexOf('DELETE episode WHERE'),
    );

    // Grounding episodes (a pre-transaction read) must be resolved BEFORE the
    // transaction that deletes the facts naming them.
    const groundIdx = queries.findIndex((q) => q.sql.includes('SELECT source.episodeIds AS eps'));
    const txIdx = queries.findIndex((q) => q.sql.includes('BEGIN TRANSACTION'));
    expect(groundIdx).toBeGreaterThanOrEqual(0);
    expect(groundIdx).toBeLessThan(txIdx);
    // The fact DELETE lives inside that same transaction.
    expect(txSql).toContain('DELETE knowledge_fact');
  });

  it('no grounding episodes → transaction runs with an empty episode set (0 L0 deletes)', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('BEGIN TRANSACTION'))
        return {
          auditEventsDeleted: 0,
          episodesDeleted: 0,
          segmentsDeleted: 0,
          tombstone: { id: 'forgotten_entity:t1', entityIdHash: 'hmac:x' },
        };
      if (sql.includes('FROM type::record')) return [{ id: 'knowledge_entity:e' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    const res = await new EntityForgetService(surreal, cfg()).forget({
      companyId: 'co_x',
      entityIdRaw: 'knowledge_entity:e',
      dto: { reason: 'gdpr_request', requestId: 'req-2' } as never,
      actorKeyHash: 'admin1',
    });
    expect(res.episodesDeleted).toBe(0);
    expect(res.segmentsDeleted).toBe(0);
    const tx = txQuery(queries);
    expect(tx).toBeDefined();
    expect((tx?.params?.eps as unknown[]).length).toBe(0);
  });
});

describe('entity forget → idempotent retry (R4)', () => {
  it('a prior tombstone for (requestId, entity) is a no-op replay of the stored result', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('FROM forgotten_entity'))
        return [
          {
            entityIdHash: 'hmac:prior',
            factsDeleted: 5,
            edgesDeleted: 2,
            auditEventsDeleted: 3,
            episodesDeleted: 1,
            segmentsDeleted: 4,
            forgottenAt: '2026-01-01T00:00:00.000Z',
          },
        ];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    const res = await new EntityForgetService(surreal, cfg()).forget({
      companyId: 'co_x',
      entityIdRaw: 'knowledge_entity:e',
      dto: { reason: 'gdpr_request', requestId: 'req-1' } as never,
      actorKeyHash: 'admin1',
    });

    // Returns the STORED result verbatim.
    expect(res.entityIdHash).toBe('hmac:prior');
    expect(res.factsDeleted).toBe(5);
    expect(res.edgesDeleted).toBe(2);
    expect(res.auditEventsDeleted).toBe(3);
    expect(res.episodesDeleted).toBe(1);
    expect(res.segmentsDeleted).toBe(4);
    expect(res.forgottenAt).toBe('2026-01-01T00:00:00.000Z');

    // No re-erase: neither the existence check nor the transaction ran.
    expect(queries.some((q) => q.sql.includes('BEGIN TRANSACTION'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('DELETE'))).toBe(false);
    expect(queries.some((q) => q.sql.includes('type::record'))).toBe(false);
  });
});

describe('entity forget → atomicity contract (R4)', () => {
  it('a transaction failure aborts the erase: the error propagates, no success is reported', async () => {
    const { db, queries } = makeDb((sql) => {
      // The single transaction fails (server rolls it back) — the whole
      // erase must fail loud, never report a partial success.
      if (sql.includes('BEGIN TRANSACTION'))
        throw new Error('The query was not executed due to a failed transaction');
      if (sql.includes('FROM type::record')) return [{ id: 'knowledge_entity:e' }];
      if (sql.includes('SELECT id FROM knowledge_fact')) return [{ id: 'knowledge_fact:f1' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;

    await expect(
      new EntityForgetService(surreal, cfg()).forget({
        companyId: 'co_x',
        entityIdRaw: 'knowledge_entity:e',
        dto: { reason: 'gdpr_request', requestId: 'req-1' } as never,
        actorKeyHash: 'admin1',
      }),
    ).rejects.toThrow(/failed transaction/);

    // The transaction WAS attempted (the fix routes the writes through it).
    const tx = queries.find((q) => q.sql.includes('BEGIN TRANSACTION'));
    expect(tx).toBeDefined();
    // The tombstone CREATE is part of that atomic unit — never a separate
    // write that could survive a rolled-back erase.
    expect(tx!.sql).toContain('CREATE forgotten_entity');
    // No DELETE / tombstone CREATE was issued as a standalone statement
    // outside the transaction — with ONE documented exception: the 0107
    // outcome-telemetry pre-sweep (memory_outcome) deliberately runs
    // outside the atomic unit. Telemetry meta is content-free by
    // contract, so an aborted erase merely deleted telemetry early (see
    // EntityForgetService), and the sweep keeps a telemetry-heavy
    // subject from inflating the erase transaction.
    expect(
      queries.some(
        (q) =>
          !q.sql.includes('BEGIN TRANSACTION') &&
          q.sql.includes('DELETE') &&
          !q.sql.includes('memory_outcome'),
      ),
    ).toBe(false);
  });
});

describe('user forget → userIds is never edited on erasure (0117 pin)', () => {
  // Source-regex guard (audit-p1-guards style): erasure WINS over
  // retention — any window quoting an erased user's turn dies WHOLE by
  // episode reference. The 0117 userIds member set therefore never
  // needs editing on forget; a refactor that starts UPDATE-ing
  // episode_segment/memory_episode userIds instead of deleting whole
  // rows would silently retain the erased user's verbatim text.
  const source = readFileSync(
    join(__dirname, '..', 'src', 'entities', 'user-forget.service.ts'),
    'utf8',
  );

  it('mixed segments die WHOLE by episode reference', () => {
    expect(source).toContain('DELETE episode_segment WHERE episodeIds CONTAINSANY $eps');
  });

  it('no forget path edits userIds arrays', () => {
    expect(source).not.toMatch(/SET\s+userIds/);
    expect(source).not.toMatch(/UPDATE\s+episode_segment/);
    expect(source).not.toMatch(/UPDATE\s+memory_episode/);
  });
});

describe('user forget → segments follow the deleted episodes', () => {
  it('deletes segments by episode reference AND by userId', async () => {
    const { db, queries } = makeDb((sql) => {
      if (sql.includes('DELETE episode WHERE userId')) return [{ id: 'episode:u1a' }];
      return [];
    });
    const surreal = {
      withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    await new UserForgetService(surreal).forgetUser('co_x', 'u1');

    const byRef = queries.find(
      (q) => q.sql.includes('DELETE episode_segment') && q.sql.includes('CONTAINSANY'),
    );
    const byUser = queries.find(
      (q) => q.sql.includes('DELETE episode_segment') && q.sql.includes('userId'),
    );
    expect(byRef).toBeDefined();
    expect((byRef?.params?.eps as unknown[]).length).toBe(1);
    expect(byUser).toBeDefined();
  });
});
