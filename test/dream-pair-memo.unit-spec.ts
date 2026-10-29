/**
 * The nightly judges remember what they already judged (0173). Before,
 * dedup re-judged every `different`/`unsure` pair and resolve every
 * `unsure` pair, every night (LLM spend audit, 2026-10-28).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Surreal } from 'surrealdb';
import { DreamsDedupService } from '../src/dreams/dedup.service';
import type { EntityJudgeService } from '../src/ai/entity-judge.service';
import { PAIR_RECHECK_MS, alreadyJudged, pairSignature } from '../src/dreams/pair-memo';

describe('0173 dream_pair_checked', () => {
  it('defines the memo with one row per (kind, pairKey)', () => {
    const sql = readFileSync(
      join(__dirname, '../src/db/migrations/0173_dream_pair_checked.surql'),
      'utf8',
    );
    expect(sql).toContain('DEFINE TABLE IF NOT EXISTS dream_pair_checked SCHEMAFULL');
    expect(sql).toMatch(
      /dream_pair_checked_key_idx\s+ON dream_pair_checked FIELDS kind, pairKey UNIQUE/,
    );
  });
});

describe('alreadyJudged', () => {
  const sig = pairSignature('a facts', 'b facts');
  const memo = new Map([['a|b', { pairKey: 'a|b', signature: sig, checkedAt: new Date() }]]);

  it('skips a pair whose judge input is unchanged and recent', () => {
    expect(alreadyJudged(memo, { pairKey: 'a|b', signature: sig })).toBe(true);
  });

  it('judges again on new evidence, on an old memo, or on an unseen pair', () => {
    expect(
      alreadyJudged(memo, {
        pairKey: 'a|b',
        signature: pairSignature('a facts', 'b facts', 'new fact'),
      }),
    ).toBe(false);
    expect(
      alreadyJudged(memo, { pairKey: 'a|b', signature: sig }, Date.now() + PAIR_RECHECK_MS + 1),
    ).toBe(false);
    expect(alreadyJudged(memo, { pairKey: 'c|d', signature: sig })).toBe(false);
  });
});

describe('dreams dedup with the memo', () => {
  function config(): ConfigService {
    return {
      get: (k: string, d?: string) => ({ DREAMS_DEDUP_ENABLED: '1' })[k] ?? d,
    } as unknown as ConfigService;
  }

  it('pays only for the pair whose evidence changed, and remembers a `different`', async () => {
    const facts: Record<string, string> = { 'e:1': 'A', 'e:2': 'B', 'e:3': 'C', 'e:4': 'D' };
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        if (sql.includes('FROM dream_pair_checked')) {
          return [
            [{ pairKey: 'e:1|e:2', signature: pairSignature('A', 'B'), checkedAt: new Date() }],
          ];
        }
        if (sql.startsWith('UPSERT $id')) writes.push(params ?? {});
        return [[]];
      },
    } as unknown as Surreal;
    let judged = 0;
    const judge = {
      isAvailable: () => true,
      fetchTopFacts: async (_db: unknown, id: string) => facts[id],
      judge: async () => {
        judged += 1;
        return 'different';
      },
    } as unknown as EntityJudgeService;
    const svc = new DreamsDedupService(config(), judge);
    const internals = svc as unknown as {
      findCandidates: () => Promise<unknown>;
      identityEdgeExists: () => Promise<boolean>;
    };
    jest.spyOn(internals, 'findCandidates').mockResolvedValue([
      { aId: 'e:1', bId: 'e:2', cosine: 0.95 },
      { aId: 'e:3', bId: 'e:4', cosine: 0.94 },
    ]);
    jest.spyOn(internals, 'identityEdgeExists').mockResolvedValue(false);

    const result = await svc.run(db);
    expect(judged).toBe(1);
    expect(result).toMatchObject({ llmJudgements: 1, memoSkipped: 1 });
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'dedup', pairKey: 'e:3|e:4', verdict: 'different' }),
    ]);
  });
});
