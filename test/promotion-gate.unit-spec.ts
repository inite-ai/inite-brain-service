/**
 * Unit-test for the promotion consolidation gate (Brain v2 PR8) on
 * PromotionRunnerService, plus the per-tenant schedule
 * (COMPACTION_TENANT_OVERRIDES):
 *
 *   - corroboration floor (COMPACTION_PROMOTION_MIN_EPISODES): a group
 *     folds only when its members span enough DISTINCT evidence contexts
 *     (union of member source.episodeIds + source.conversationId) — five
 *     facts from ONE conversation are one witness, not five;
 *   - conflict guard (COMPACTION_PROMOTION_CONFLICT_GUARD): sibling
 *     COMPETING rows abort the group loudly;
 *   - both off/unset → promotion byte-identical to today (pinned);
 *   - the per-tenant override changes the effective floor.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PromotionRunnerService } from '../src/compaction/promotion-runner.service';
import type { EmbedderService } from '../src/ai/embedder.service';
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

interface PromotableSeed {
  id: string;
  object: string;
  validFrom: string;
  eps?: string[];
  conversationId?: string;
}

function makePromotionStack(
  seeds: PromotableSeed[],
  config: Record<string, string>,
  opts: { competingCount?: number } = {},
) {
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
      // The competing-sibling count query ALSO matches the member
      // SELECT's WHERE prefix — discriminate on the status literal first.
      if (sql.includes("status = 'competing'")) {
        return [[{ n: opts.competingCount ?? 0 }]] as unknown as R;
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
            ...(s.conversationId ? { conversationId: s.conversationId } : {}),
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
      ...config,
    }) as unknown as ConfigService,
    embedder,
    { generate: async () => 'promoted summary' },
  );
  return { runner, calls, created };
}

// 'said' is a seed append_only predicate — the only class promotion folds.
// Five aged facts, ALL grounded in the same single conversation.
const ONE_CONVERSATION: PromotableSeed[] = Array.from({ length: 5 }, (_, i) => ({
  id: `knowledge_fact:s${i}`,
  object: `old remark ${i}`,
  validFrom: `2025-0${i + 1}-01T00:00:00Z`,
  conversationId: 'conv_1',
}));

// The same five facts, spanning two conversations (and one episode stamp).
const TWO_CONVERSATIONS: PromotableSeed[] = ONE_CONVERSATION.map((s, i) => ({
  ...s,
  conversationId: i < 3 ? 'conv_1' : 'conv_2',
  ...(i === 0 ? { eps: ['episode:e1'] } : {}),
}));

const savedOverrides = process.env.COMPACTION_TENANT_OVERRIDES;
afterEach(() => {
  if (savedOverrides === undefined) delete process.env.COMPACTION_TENANT_OVERRIDES;
  else process.env.COMPACTION_TENANT_OVERRIDES = savedOverrides;
  jest.restoreAllMocks();
});

describe('PromotionRunnerService — corroboration floor', () => {
  it('skips a single-conversation group below the floor (and says so at debug)', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const { runner, created } = makePromotionStack(ONE_CONVERSATION, {
      COMPACTION_PROMOTION_MIN_EPISODES: '2',
    });
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(0);
    expect(stats.factsPromoted).toBe(0);
    expect(created).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining(
        'promotion skipped (corroboration floor): knowledge_entity:e1/said distinct=1 < 2',
      ),
    );
  });

  it('promotes a group spanning two conversations at floor 2', async () => {
    const { runner, created } = makePromotionStack(TWO_CONVERSATIONS, {
      COMPACTION_PROMOTION_MIN_EPISODES: '2',
    });
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(stats.factsPromoted).toBe(5);
    expect(created).toHaveLength(1);
    expect(created[0]!.predicate).toBe('summary_said');
  });

  it('counts episode stamps and conversation ids into ONE distinct-context set', async () => {
    // One conversation only, but two members carry distinct episode
    // stamps: contexts = {episode:e1, episode:e2, conv_1} = 3.
    const seeds = ONE_CONVERSATION.map((s, i) => ({
      ...s,
      ...(i === 0 ? { eps: ['episode:e1'] } : {}),
      ...(i === 1 ? { eps: ['episode:e2'] } : {}),
    }));
    const { runner, created } = makePromotionStack(seeds, {
      COMPACTION_PROMOTION_MIN_EPISODES: '3',
    });
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('the member SELECT carries the evidence-context column', async () => {
    const { runner, calls } = makePromotionStack(TWO_CONVERSATIONS, {});
    await runner.promoteCompany('co_a');
    const select = calls.find((c) => c.sql.includes('WHERE entityId = $entity'))!;
    expect(select.sql).toContain('source.conversationId AS conversationId');
  });
});

describe('PromotionRunnerService — conflict guard', () => {
  it('aborts a contested group loudly (competing siblings present)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { runner, created } = makePromotionStack(
      TWO_CONVERSATIONS,
      { COMPACTION_PROMOTION_CONFLICT_GUARD: '1' },
      { competingCount: 3 },
    );
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(0);
    expect(created).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'contested group NOT promoted: knowledge_entity:e1/said, 3 competing rows',
      ),
    );
  });

  it('promotes an uncontested group with the guard on (count = 0)', async () => {
    const { runner, created, calls } = makePromotionStack(
      TWO_CONVERSATIONS,
      { COMPACTION_PROMOTION_CONFLICT_GUARD: '1' },
      { competingCount: 0 },
    );
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(created).toHaveLength(1);
    // The guard issued exactly one count query for the group.
    expect(calls.filter((c) => c.sql.includes("status = 'competing'"))).toHaveLength(1);
  });
});

describe('PromotionRunnerService — gate off/unset is byte-identical (pin)', () => {
  it('single-conversation group promotes exactly as today; no competing query fires', async () => {
    const { runner, created, calls } = makePromotionStack(ONE_CONVERSATION, {});
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(stats.factsPromoted).toBe(5);
    expect(created).toHaveLength(1);
    const summary = created[0]!;
    expect(summary.predicate).toBe('summary_said');
    expect(summary.object).toBe('promoted summary');
    expect(summary.status).toBe('active');
    expect(summary.source).toEqual({ kind: 'promotion' });
    expect((summary.derivedFrom as unknown[]).length).toBe(5);
    // No consolidation-gate query was issued.
    expect(calls.some((c) => c.sql.includes("status = 'competing'"))).toBe(false);
  });
});

describe('PromotionRunnerService — per-tenant schedule (COMPACTION_TENANT_OVERRIDES)', () => {
  it('the tenant override raises the effective floor for THAT tenant only', async () => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    process.env.COMPACTION_TENANT_OVERRIDES = JSON.stringify({
      co_a: { promotionMinEpisodes: 2 },
    });
    // Env default floor is 0 (off): co_a inherits 2 from its override
    // and skips the single-witness group…
    const a = makePromotionStack(ONE_CONVERSATION, {});
    const statsA = await a.runner.promoteCompany('co_a');
    expect(statsA.groupsPromoted).toBe(0);
    expect(a.created).toHaveLength(0);
    // …while co_b keeps the process default and promotes it.
    const b = makePromotionStack(ONE_CONVERSATION, {});
    const statsB = await b.runner.promoteCompany('co_b');
    expect(statsB.groupsPromoted).toBe(1);
    expect(b.created).toHaveLength(1);
  });

  it('the tenant override can LOWER the env floor (override wins over env default)', async () => {
    process.env.COMPACTION_TENANT_OVERRIDES = JSON.stringify({
      co_a: { promotionMinEpisodes: 0 },
    });
    const { runner, created } = makePromotionStack(ONE_CONVERSATION, {
      COMPACTION_PROMOTION_MIN_EPISODES: '2',
    });
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('promotionMinGroup override changes the group-size threshold', async () => {
    process.env.COMPACTION_TENANT_OVERRIDES = JSON.stringify({
      co_a: { promotionMinGroup: 6 },
    });
    // 5 members < 6 → the group no longer qualifies for co_a.
    const { runner, created } = makePromotionStack(ONE_CONVERSATION, {});
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('promotionAgeDays override moves the cutoff for that tenant', async () => {
    process.env.COMPACTION_TENANT_OVERRIDES = JSON.stringify({
      co_a: { promotionAgeDays: 30 },
    });
    const { runner, calls } = makePromotionStack(ONE_CONVERSATION, {});
    const before = Date.now();
    await runner.promoteCompany('co_a');
    const after = Date.now();
    const select = calls.find((c) => c.sql.includes('GROUP BY entityId'))!;
    const cutoff = select.params!.cutoff as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 30 * 24 * 60 * 60 * 1000);
  });

  it('a malformed overrides env fails open to the process defaults', async () => {
    process.env.COMPACTION_TENANT_OVERRIDES = 'not-json{';
    const { runner, created } = makePromotionStack(ONE_CONVERSATION, {});
    const stats = await runner.promoteCompany('co_a');
    expect(stats.groupsPromoted).toBe(1);
    expect(created).toHaveLength(1);
  });
});
