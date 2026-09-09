/**
 * Promotion summary validity and the atomic replace (audit 2026-09-06 F4).
 *
 * A promotion summary REPLACES active memory: the originals are compacted
 * and hidden from every read surface. It used to be created with
 * `validUntil = last.validUntil ?? last.validFrom`, so a group of old
 * open-ended events — the ordinary case for append_only history — got a
 * replacement that was already expired under the default "actual now"
 * search filter. Five facts promoted, zero rows visible.
 *
 * Pinned here:
 *   - validity is the originals' validity: open-ended if any member is
 *     open-ended, else the latest member close — never derived from
 *     validFrom;
 *   - the events' own span survives as `source.eventRange`;
 *   - the summary CREATE and the members' compaction travel in ONE
 *     transaction, never as two round-trips.
 */
import { ConfigService } from '@nestjs/config';
import {
  PromotionRunnerService,
  summaryValidityOf,
} from '../src/compaction/promotion-runner.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { SurrealService } from '../src/db/surreal.service';

describe('summaryValidityOf', () => {
  it('open-ended members → open-ended summary (validUntil absent), range = first..last validFrom', () => {
    const v = summaryValidityOf([
      { validFrom: '2025-01-01T00:00:00Z' },
      { validFrom: '2025-03-01T00:00:00Z', validUntil: null },
      { validFrom: '2025-05-01T00:00:00Z' },
    ]);
    expect(v.validFrom).toBe('2025-01-01T00:00:00Z');
    expect('validUntil' in v).toBe(false);
    expect(v.eventRange).toEqual({ from: '2025-01-01T00:00:00Z', to: '2025-05-01T00:00:00Z' });
  });

  it('every member closed → summary closes at the LATEST close, not the last row', () => {
    const v = summaryValidityOf([
      { validFrom: '2025-01-01T00:00:00Z', validUntil: '2025-12-01T00:00:00Z' },
      { validFrom: '2025-02-01T00:00:00Z', validUntil: '2025-02-02T00:00:00Z' },
    ]);
    expect(v.validUntil).toBe('2025-12-01T00:00:00Z');
    expect(v.eventRange).toEqual({ from: '2025-01-01T00:00:00Z', to: '2025-02-02T00:00:00Z' });
  });

  it('one open-ended member keeps the whole summary open-ended', () => {
    const v = summaryValidityOf([
      { validFrom: '2025-01-01T00:00:00Z', validUntil: '2025-01-02T00:00:00Z' },
      { validFrom: '2025-02-01T00:00:00Z' },
    ]);
    expect('validUntil' in v).toBe(false);
  });

  it('accepts the Date objects the SDK returns and reports the range as ISO', () => {
    const v = summaryValidityOf([
      { validFrom: new Date('2025-01-01T00:00:00Z'), validUntil: new Date('2025-06-01T00:00:00Z') },
      { validFrom: new Date('2025-02-01T00:00:00Z'), validUntil: new Date('2025-03-01T00:00:00Z') },
    ]);
    expect(v.validUntil).toEqual(new Date('2025-06-01T00:00:00Z'));
    expect(v.eventRange).toEqual({
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-03-01T00:00:00.000Z',
    });
  });
});

describe('PromotionRunnerService — the replace is one transaction', () => {
  class StubConfig {
    constructor(private readonly map: Record<string, string> = {}) {}
    get<T = string>(key: string, fallback?: T): T {
      return (this.map[key] as unknown as T) ?? (fallback as T);
    }
  }

  function stack(members: Array<{ validFrom: string; validUntil?: string }>) {
    const sqls: string[] = [];
    let txParams: Record<string, unknown> | undefined;
    const fakeDb = {
      async query<R>(sql: string, params?: Record<string, unknown>): Promise<R> {
        sqls.push(sql);
        if (sql.includes('GROUP BY entityId, predicate, userId')) {
          return [
            [{ entityId: 'knowledge_entity:e1', predicate: 'said', n: members.length }],
          ] as unknown as R;
        }
        if (sql.includes('WHERE entityId = $entity AND predicate = $predicate')) {
          return [
            members.map((m, i) => ({
              id: `knowledge_fact:s${i}`,
              entityId: 'knowledge_entity:e1',
              predicate: 'said',
              object: `old remark ${i}`,
              validFrom: m.validFrom,
              ...(m.validUntil ? { validUntil: m.validUntil } : {}),
              confidence: 0.9,
            })),
          ] as unknown as R;
        }
        if (sql.startsWith('BEGIN TRANSACTION')) {
          txParams = params;
          return [null, null, [], [{ id: 'knowledge_fact:summary1' }], null] as unknown as R;
        }
        return [[]] as unknown as R;
      },
    };
    const surreal = {
      withCompany: async <T>(_c: string, fn: (db: unknown) => Promise<T>) => fn(fakeDb),
    } as unknown as SurrealService;
    const embedder = { embedForWrite: async () => [1, 0] } as unknown as EmbedderService;
    const runner = new PromotionRunnerService(
      surreal,
      new StubConfig({
        COMPACTION_PROMOTION_ENABLED: '1',
        COMPACTION_PROMOTION_MIN_GROUP: '2',
      }) as unknown as ConfigService,
      embedder,
      { generate: async () => 'promoted summary' },
    );
    return { runner, sqls, tx: () => txParams };
  }

  it('creates the summary and compacts the originals in ONE batch, with no standalone UPDATE', async () => {
    const { runner, sqls, tx } = stack([
      { validFrom: '2025-01-01T00:00:00Z' },
      { validFrom: '2025-02-01T00:00:00Z' },
    ]);
    const stats = await runner.promoteCompany('co_a');
    expect(stats).toEqual({ companyId: 'co_a', groupsPromoted: 1, factsPromoted: 2 });

    const batches = sqls.filter((s) => s.startsWith('BEGIN TRANSACTION'));
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toContain('CREATE knowledge_fact CONTENT $doc');
    expect(batch).toContain("SET status = 'compacted', embedding = NONE");
    expect(batch.trim().endsWith('COMMIT TRANSACTION;')).toBe(true);
    // The compaction never travels on its own — that was the window where
    // the originals were hidden with nothing standing in for them.
    expect(sqls.filter((s) => s.trimStart().startsWith('UPDATE knowledge_fact'))).toHaveLength(0);

    const params = tx()!;
    expect((params.ids as unknown[]).map(String)).toEqual([
      'knowledge_fact:s0',
      'knowledge_fact:s1',
    ]);
    const doc = params.doc as Record<string, unknown>;
    expect(doc.predicate).toBe('summary_said');
    expect(doc.status).toBe('active');
    expect(doc.validFrom).toBe('2025-01-01T00:00:00Z');
    // Open-ended originals → an open-ended replacement: the key is absent.
    expect('validUntil' in doc).toBe(false);
    expect(doc.source).toEqual({
      kind: 'promotion',
      eventRange: { from: '2025-01-01T00:00:00Z', to: '2025-02-01T00:00:00Z' },
    });
    expect(doc.embedding).toEqual([1, 0]);
  });

  it('closed originals give the replacement their latest close', async () => {
    const { runner, tx } = stack([
      { validFrom: '2025-01-01T00:00:00Z', validUntil: '2025-04-01T00:00:00Z' },
      { validFrom: '2025-02-01T00:00:00Z', validUntil: '2025-03-01T00:00:00Z' },
    ]);
    await runner.promoteCompany('co_a');
    const doc = tx()!.doc as Record<string, unknown>;
    expect(doc.validUntil).toBe('2025-04-01T00:00:00Z');
    expect((doc.source as { eventRange: unknown }).eventRange).toEqual({
      from: '2025-01-01T00:00:00Z',
      to: '2025-03-01T00:00:00Z',
    });
  });

  it('a transaction that returns no summary row is an error, not a silent success', async () => {
    const { runner, sqls } = stack([
      { validFrom: '2025-01-01T00:00:00Z' },
      { validFrom: '2025-02-01T00:00:00Z' },
    ]);
    // Simulate a batch whose RETURN slot is empty (aborted server-side).
    const db = (runner as unknown as { surreal: SurrealService }).surreal;
    (db as unknown as { withCompany: unknown }).withCompany = async <T>(
      _c: string,
      fn: (d: unknown) => Promise<T>,
    ) =>
      fn({
        async query<R>(sql: string): Promise<R> {
          sqls.push(sql);
          if (sql.includes('GROUP BY entityId, predicate, userId')) {
            return [[{ entityId: 'knowledge_entity:e1', predicate: 'said', n: 2 }]] as unknown as R;
          }
          if (sql.includes('WHERE entityId = $entity AND predicate = $predicate')) {
            return [
              [
                {
                  id: 'knowledge_fact:s0',
                  entityId: 'knowledge_entity:e1',
                  predicate: 'said',
                  object: 'a',
                  validFrom: '2025-01-01T00:00:00Z',
                  confidence: 0.9,
                },
                {
                  id: 'knowledge_fact:s1',
                  entityId: 'knowledge_entity:e1',
                  predicate: 'said',
                  object: 'b',
                  validFrom: '2025-02-01T00:00:00Z',
                  confidence: 0.9,
                },
              ],
            ] as unknown as R;
          }
          if (sql.startsWith('BEGIN TRANSACTION'))
            return [null, null, [], [], null] as unknown as R;
          return [[]] as unknown as R;
        },
      });
    // promoteCompany logs and counts a failed group as not promoted.
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(0);
    expect(stats.factsPromoted).toBe(0);
  });
});
