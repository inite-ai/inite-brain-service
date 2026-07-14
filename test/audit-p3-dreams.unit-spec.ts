/**
 * Wave P3 of the 2026-07 performance audit — flag-gated pipeline guards.
 *
 * 1. Migrations 0060/0061 define the negative-memo and build-state
 *    tables the corroborate / community passes now rely on.
 * 2. Corroborate skips groups whose member count matches the 0060 memo
 *    (the deterministic window no longer restarves on stuck groups) and
 *    stops judging at the hard LLM-call ceiling.
 * 3. Community builder short-circuits a full rebuild when the live-edge
 *    signature is unchanged.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DreamsCorroborateService } from '../src/dreams/corroborate.service';
import { CommunityBuilderService } from '../src/communities/community-builder.service';

const MIGRATIONS = join(__dirname, '..', 'src', 'db', 'migrations');

describe('P3 migrations', () => {
  it('0060 defines corroborate_checked with a unique group index', () => {
    const sql = readFileSync(
      join(MIGRATIONS, '0060_corroborate_checked.surql'),
      'utf8',
    );
    expect(sql).toContain('DEFINE TABLE IF NOT EXISTS corroborate_checked');
    for (const field of ['entityId', 'predicate', 'memberCount', 'checkedAt']) {
      expect(sql).toContain(`DEFINE FIELD IF NOT EXISTS ${field}`);
    }
    expect(sql).toMatch(/corroborate_checked_group_idx[\s\S]*UNIQUE/);
  });

  it('0061 defines community_build_state signature fields', () => {
    const sql = readFileSync(
      join(MIGRATIONS, '0061_community_build_state.surql'),
      'utf8',
    );
    expect(sql).toContain('DEFINE TABLE IF NOT EXISTS community_build_state');
    for (const field of ['liveEdgeCount', 'maxEdgeAt', 'minSize']) {
      expect(sql).toContain(`DEFINE FIELD IF NOT EXISTS ${field}`);
    }
  });
});

type Row = Record<string, unknown>;

function fact(over: Partial<Row> = {}): Row {
  return {
    id: `knowledge_fact:${Math.random().toString(36).slice(2, 8)}`,
    entityId: 'knowledge_entity:e1',
    predicate: 'claim_probe',
    object: 'gold tier customer',
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: null,
    recordedAt: '2026-06-01T00:00:00Z',
    embedding: [1, 0],
    originKey: 'doc:a',
    corroborationCount: 0,
    ...over,
  };
}

function mkCorroborate(extraEnv: Record<string, string> = {}) {
  const svc = new DreamsCorroborateService(
    new ConfigService({
      DREAMS_CORROBORATE_ENABLED: '1',
      OPENAI_API_KEY: 'sk-test',
      ...extraEnv,
    }),
  );
  const judge = jest.fn();
  (svc as unknown as { judge: unknown }).judge = judge;
  return { svc, judge };
}

/**
 * db mock: group listing, 0060 memo read/write, member fetch, and the
 * corroboration apply — enough surface for run() end-to-end.
 */
function mkDb(opts: {
  groups: Array<{ entityId: string; predicate: string; n: number }>;
  membersByGroup: Record<string, Row[]>;
  memo?: Array<{ entityId: string; predicate: string; memberCount: number }>;
}) {
  const memoWrites: Array<Record<string, unknown>> = [];
  const memberFetches: string[] = [];
  const query = jest.fn(async (sql: string, params?: Record<string, unknown>) => {
    if (sql.includes('GROUP BY entityId, predicate')) {
      return [opts.groups];
    }
    if (sql.includes('FROM corroborate_checked')) {
      return [opts.memo ?? []];
    }
    if (sql.includes('UPSERT corroborate_checked')) {
      memoWrites.push(params ?? {});
      return [[]];
    }
    if (sql.includes('fn::origin_key_of(source) AS originKey')) {
      const key = `${String(params?.entity)}|${String(params?.predicate)}`;
      memberFetches.push(key);
      return [opts.membersByGroup[key] ?? []];
    }
    if (sql.includes(`status = 'corroborating'`)) {
      return [[]];
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  return { db: { query }, memoWrites, memberFetches };
}

describe('DreamsCorroborateService 0060 memo + LLM ceiling', () => {
  it('skips groups whose member count matches the memo and marks processed groups', async () => {
    const { svc, judge } = mkCorroborate();
    const a = fact({ id: 'knowledge_fact:a', originKey: 'doc:a' });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const groups = [
      { entityId: 'knowledge_entity:e1', predicate: 'claim_probe', n: 2 },
      { entityId: 'knowledge_entity:e2', predicate: 'claim_probe', n: 2 },
    ];
    const { db, memoWrites, memberFetches } = mkDb({
      groups,
      membersByGroup: {
        'knowledge_entity:e1|claim_probe': [a, b],
        'knowledge_entity:e2|claim_probe': [],
      },
      // e2 already checked at the same member count → must be skipped.
      memo: [
        { entityId: 'knowledge_entity:e2', predicate: 'claim_probe', memberCount: 2 },
      ],
    });

    const out = await svc.run(db as never);

    expect(out.groupsConsidered).toBe(1);
    expect(memberFetches).toEqual(['knowledge_entity:e1|claim_probe']);
    expect(out.corroborationsApplied).toBe(1); // exact match, no LLM
    expect(judge).not.toHaveBeenCalled();
    // The processed group is memo'd with its member count.
    expect(memoWrites).toHaveLength(1);
    expect(memoWrites[0]).toMatchObject({ predicate: 'claim_probe', n: 2 });
  });

  it('re-qualifies a memo group whose member count changed', async () => {
    const { svc } = mkCorroborate();
    const a = fact({ id: 'knowledge_fact:a', originKey: 'doc:a' });
    const b = fact({
      id: 'knowledge_fact:b',
      originKey: 'doc:b',
      recordedAt: '2026-06-02T00:00:00Z',
    });
    const { db, memberFetches } = mkDb({
      groups: [{ entityId: 'knowledge_entity:e1', predicate: 'claim_probe', n: 2 }],
      membersByGroup: { 'knowledge_entity:e1|claim_probe': [a, b] },
      memo: [
        { entityId: 'knowledge_entity:e1', predicate: 'claim_probe', memberCount: 3 },
      ],
    });
    const out = await svc.run(db as never);
    expect(out.groupsConsidered).toBe(1);
    expect(memberFetches).toHaveLength(1);
  });

  it('stops judging at the hard LLM-call ceiling', async () => {
    const { svc, judge } = mkCorroborate({
      DREAMS_CORROBORATE_MAX_LLM_CALLS: '2',
    });
    judge.mockResolvedValue('different'); // never applies → old code kept going
    const mkGroupMembers = (suffix: string): Row[] => [
      fact({
        id: `knowledge_fact:a${suffix}`,
        entityId: `knowledge_entity:${suffix}`,
        originKey: 'doc:a',
        object: `value one ${suffix}`,
      }),
      fact({
        id: `knowledge_fact:b${suffix}`,
        entityId: `knowledge_entity:${suffix}`,
        originKey: 'doc:b',
        object: `value two ${suffix}`,
        recordedAt: '2026-06-02T00:00:00Z',
      }),
    ];
    const groups = ['g1', 'g2', 'g3', 'g4'].map((s) => ({
      entityId: `knowledge_entity:${s}`,
      predicate: 'claim_probe',
      n: 2,
    }));
    const membersByGroup = Object.fromEntries(
      ['g1', 'g2', 'g3', 'g4'].map((s) => [
        `knowledge_entity:${s}|claim_probe`,
        mkGroupMembers(s),
      ]),
    );
    const { db } = mkDb({ groups, membersByGroup });

    const out = await svc.run(db as never);

    // Ceiling 2: judges g1 (1 call) and g2 (1 call), then stops — g3/g4
    // wait for the next run instead of burning the full window.
    expect(out.llmJudgements).toBe(2);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(out.corroborationsApplied).toBe(0);
  });
});

describe('CommunityBuilderService signature short-circuit', () => {
  function mkBuilder() {
    return new CommunityBuilderService(
      new ConfigService({ DREAMS_COMMUNITIES_ENABLED: '1' }),
      { embed: jest.fn() } as never,
      { generate: jest.fn() } as never,
    );
  }

  it('skips the edge load when the live-edge signature is unchanged', async () => {
    const svc = mkBuilder();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('GROUP ALL')) {
        return [[{ c: 42, maxAt: '2026-07-01T00:00:00Z' }]];
      }
      if (sql.includes('FROM community_build_state')) {
        return [
          [
            {
              liveEdgeCount: 42,
              maxEdgeAt: '2026-07-01T00:00:00Z',
              minSize: 3,
            },
          ],
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const out = await svc.run({ query } as never);

    expect(out).toEqual({
      communitiesBuilt: 0,
      communitiesReused: 0,
      communitiesRemoved: 0,
      entitiesClustered: 0,
    });
    // Only the two signature queries ran — no edge load, no clustering.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('runs the full pass when the stored signature differs', async () => {
    const svc = mkBuilder();
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('GROUP ALL')) {
        return [[{ c: 42, maxAt: '2026-07-01T00:00:00Z' }]];
      }
      if (sql.includes('FROM community_build_state')) {
        return [[{ liveEdgeCount: 41, maxEdgeAt: '2026-06-30T00:00:00Z', minSize: 3 }]];
      }
      if (sql.includes('FROM knowledge_edge')) {
        return [[]]; // empty graph → removeAllCommunities path
      }
      if (sql.includes('community')) {
        return [[]];
      }
      return [[]];
    });

    await svc.run({ query } as never);

    expect(calls.some((s) => s.includes('FROM knowledge_edge'))).toBe(true);
  });
});
