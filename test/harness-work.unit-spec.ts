/**
 * Harness mode (#819): every background reading the server's model did —
 * predicate cardinality, same-entity and competing/corroborating fact
 * judgements, scene summaries, belief sentences — is handed to the
 * connected agent in batches and applied by the server's own writes.
 *
 *  - each kind's token round-trips and refuses a malformed payload;
 *  - a batch carries only what the caller's scope may read;
 *  - a verdict is applied by the pass's own write, and an item whose
 *    evidence moved since it was handed out is skipped (stale), so a batch
 *    applied twice changes nothing the second time;
 *  - in harness mode the nightly passes never memoize a refused judgement.
 */
import { DreamsWorkService, parseVerdicts } from '../src/dreams/dreams-work.service';
import { pairSignature } from '../src/dreams/pair-memo';
import { DreamsResolverService } from '../src/dreams/resolver.service';
import { BeliefStatementWorkService } from '../src/admin/belief-statement-work.service';
import { PredicateSemanticsWorkService } from '../src/ai/predicate-semantics-work.service';
import { HARNESS_SEMANTICS_PENDING } from '../src/ai/predicate-registry.service';
import {
  HARNESS_WORK_KINDS,
  mintWorkToken,
  verifyWorkToken,
  type BeliefsTokenPayload,
  type PairsTokenPayload,
  type PredicatesTokenPayload,
  type WorkTokenPayload,
} from '../src/common/harness-work-token';

const ENV = ['FORGET_HMAC_KEY', 'SOURCE_CREDENTIAL_ENCRYPTION_KEY', 'EXTRACTION_SOURCE'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.FORGET_HMAC_KEY = 'harness-work-spec-key';
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const base = { v: 2 as const, c: 'co_a', n: 'n', exp: Math.floor(Date.now() / 1000) + 600 };

type Query = (sql: string, params?: Record<string, unknown>) => Promise<unknown[]>;
function surrealOver(query: Query) {
  const db = { query: jest.fn(query) };
  return {
    db,
    surreal: { withCompany: async (_c: string, fn: (d: unknown) => unknown) => fn(db) },
  };
}

describe('work tokens of every kind', () => {
  it('offers the kinds in order: attributes, then facts, beliefs last', () => {
    expect(HARNESS_WORK_KINDS.slice(0, 2)).toEqual(['predicate_semantics', 'extraction']);
    expect(HARNESS_WORK_KINDS.at(-1)).toBe('belief_statement');
  });

  it.each<WorkTokenPayload>([
    { ...base, t: 'entity_match', p: [['a', 'b', 's']] },
    { ...base, t: 'fact_conflict', p: [['a', 'b', 's']] },
    { ...base, t: 'fact_corroboration', p: [['a', 'b', 's']] },
    { ...base, t: 'scene_summary', s: ['memory_episode:1'], ev: 'r' },
    { ...base, t: 'predicate_semantics', q: ['gym_plan'] },
    { ...base, t: 'belief_statement', u: 'u1', b: [['semantic_belief:1', 's']] },
  ])('round-trips $t', (p) => {
    expect(verifyWorkToken(mintWorkToken(p))).toEqual({ state: 'valid', payload: p });
  });

  it('refuses a kind whose items are missing', () => {
    const forge = (p: object) => mintWorkToken(p as WorkTokenPayload);
    expect(verifyWorkToken(forge({ ...base, t: 'entity_match', p: [] })).state).toBe('invalid');
    expect(verifyWorkToken(forge({ ...base, t: 'scene_summary', s: ['x'] })).state).toBe('invalid');
    expect(verifyWorkToken(forge({ ...base, t: 'belief_statement', b: [['x']] })).state).toBe(
      'invalid',
    );
  });
});

describe('parseVerdicts', () => {
  it('keys verdicts by pair number and drops unknown verdicts and repeats', () => {
    const v = parseVerdicts(
      {
        verdicts: [
          { pair: 'P1', verdict: 'same' },
          { pair: '[p2]', verdict: 'maybe' },
          { pair: 'p1', verdict: 'different' },
        ],
      },
      ['same', 'different', 'unsure'],
    );
    expect([...v]).toEqual([['p1', 'same']]);
  });

  it('refuses a reply without a verdicts array', () => {
    expect(() => parseVerdicts({}, ['same'])).toThrow(/verdicts/);
  });
});

function dreamsWork(query: Query, over: Record<string, unknown> = {}) {
  const { db, surreal } = surrealOver(query);
  const dedup = {
    configured: () => true,
    findCandidates: jest.fn(async () => [
      { aId: 'knowledge_entity:a', bId: 'knowledge_entity:b', cosine: 0.95 },
    ]),
    identityEdgeExists: jest.fn(async () => false),
    linkIdentity: jest.fn(async () => undefined),
  };
  const resolver = {
    configured: () => true,
    findCompetingPairs: jest.fn(async () => []),
    fetchEntityContext: jest.fn(async () => '- ctx'),
    markSuperseded: jest.fn(async () => undefined),
  };
  const judge = {
    fetchTopFacts: jest.fn(async (_d: unknown, id: string) => `- facts of ${id}`),
  };
  const corroborate = {
    configured: () => true,
    findCandidateGroups: jest.fn(async () => ({ groups: [], backlog: 0 })),
    fetchGroupMembers: jest.fn(async () => []),
    selectPairs: jest.fn(() => []),
    applyCorroboration: jest.fn(async () => undefined),
  };
  const work = new DreamsWorkService(
    surreal as never,
    { ...dedup, ...over } as never,
    resolver as never,
    judge as never,
    corroborate as never,
  );
  return { work, db, dedup, resolver, judge, corroborate };
}

describe('entity_match', () => {
  it("shows each side's facts through the caller's fence and signs the evidence", async () => {
    const h = dreamsWork(async (sql) => {
      if (sql.includes('dream_pair_checked')) return [[]];
      if (sql.includes('canonicalName')) {
        return [
          [
            { id: 'knowledge_entity:a', canonicalName: 'Orbital Dynamics' },
            { id: 'knowledge_entity:b', canonicalName: 'Orbital Dynamics Inc.' },
          ],
        ];
      }
      return [[]];
    });
    const work = await h.work.takeEntityMatch('co_a', { userId: 'u1' });
    expect(work?.kind).toBe('entity_match');
    expect(work?.userContent).toContain('Pair p1:');
    expect(work?.userContent).toContain('Orbital Dynamics Inc.');
    expect(h.judge.fetchTopFacts).toHaveBeenCalledWith(expect.anything(), 'knowledge_entity:a', {
      userId: 'u1',
    });
    const v = verifyWorkToken(work?.token);
    expect(v.state === 'valid' && v.payload).toMatchObject({
      t: 'entity_match',
      u: 'u1',
      p: [
        [
          'knowledge_entity:a',
          'knowledge_entity:b',
          pairSignature('- facts of knowledge_entity:a', '- facts of knowledge_entity:b'),
        ],
      ],
    });
  });

  it('links on same, memoizes different, and skips a pair whose evidence moved', async () => {
    const memo: unknown[] = [];
    const h = dreamsWork(async (sql, params) => {
      if (sql.includes('UPSERT')) memo.push(params);
      return [[]];
    });
    const sig = pairSignature('- facts of knowledge_entity:a', '- facts of knowledge_entity:b');
    const payload: PairsTokenPayload = {
      ...base,
      t: 'entity_match',
      p: [
        ['knowledge_entity:a', 'knowledge_entity:b', sig],
        ['knowledge_entity:a', 'knowledge_entity:b', 'moved'],
      ],
    };
    const out = await h.work.submit('co_a', payload, {
      verdicts: [
        { pair: 'p1', verdict: 'same' },
        { pair: 'p2', verdict: 'different' },
      ],
    });
    expect(out).toEqual({ pairs: 2, applied: 1, unsure: 0, stale: 1, missing: 0 });
    expect(h.dedup.linkIdentity).toHaveBeenCalledTimes(1);
    expect(memo).toHaveLength(0);
  });
});

describe('fact_conflict', () => {
  const row = (id: string, object: string) => ({
    id,
    entityId: 'knowledge_entity:e',
    predicate: 'gym_plan',
    object,
    confidence: 0.8,
    validFrom: '2026-10-01T00:00:00Z',
    recordedAt: '2026-10-01T00:00:00Z',
    source: {},
    userId: 'u1',
  });

  it("offers a user's pair to that user only", async () => {
    const h = dreamsWork(async () => [[]]);
    h.resolver.findCompetingPairs.mockResolvedValue([
      { a: row('knowledge_fact:1', 'premium'), b: row('knowledge_fact:2', 'basic') },
    ] as never);
    expect(await h.work.takeFactConflict('co_a', {})).toBeNull();
    expect(await h.work.takeFactConflict('co_a', { userId: 'u2' })).toBeNull();
    const mine = await h.work.takeFactConflict('co_a', { userId: 'u1' });
    expect(mine?.userContent).toContain('Fact B: gym_plan = "basic"');
  });

  it('supersedes the loser on a verdict and leaves a pair that stopped competing', async () => {
    let competing = [row('knowledge_fact:1', 'premium'), row('knowledge_fact:2', 'basic')];
    const h = dreamsWork(async (sql) => (sql.includes('FROM [$a, $b]') ? [competing] : [[]]));
    const sig = pairSignature('premium', 'basic', '- ctx');
    const payload: PairsTokenPayload = {
      ...base,
      t: 'fact_conflict',
      u: 'u1',
      p: [['knowledge_fact:1', 'knowledge_fact:2', sig]],
    };
    const reply = { verdicts: [{ pair: 'p1', verdict: 'b_wins' }] };
    expect(await h.work.submit('co_a', payload, reply)).toMatchObject({ applied: 1, stale: 0 });
    expect(h.resolver.markSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      'knowledge_fact:1',
      'knowledge_fact:2',
    );
    competing = [row('knowledge_fact:2', 'basic')];
    expect(await h.work.submit('co_a', payload, reply)).toMatchObject({ applied: 0, stale: 1 });
  });
});

describe('fact_corroboration', () => {
  it('corroborates on same_assertion when both facts still stand as asked', async () => {
    const facts = [
      { id: 'knowledge_fact:1', object: 'lives in Porto', predicate: 'lives_in' },
      { id: 'knowledge_fact:2', object: 'based in Porto', predicate: 'lives_in' },
    ];
    const h = dreamsWork(async (sql) => (sql.includes('FROM [$a, $b]') ? [facts] : [[]]));
    const payload: PairsTokenPayload = {
      ...base,
      t: 'fact_corroboration',
      p: [
        ['knowledge_fact:1', 'knowledge_fact:2', pairSignature('lives in Porto', 'based in Porto')],
      ],
    };
    const out = await h.work.submit('co_a', payload, {
      verdicts: [{ pair: 'p1', verdict: 'same_assertion' }],
    });
    expect(out.applied).toBe(1);
    expect(h.corroborate.applyCorroboration).toHaveBeenCalledTimes(1);
  });
});

describe('the resolve pass settles the pair', () => {
  it('returns the winner to active when it closes the loser', async () => {
    const sqls: string[] = [];
    const db = {
      query: jest.fn(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('SELECT validFrom FROM $w')) return [[{ validFrom: '2026-10-15' }]];
        if (sql.includes('SELECT validFrom, validUntil FROM $l')) {
          return [[{ validFrom: '2026-09-01', validUntil: null }]];
        }
        return [[]];
      }),
    };
    const resolver = new DreamsResolverService({ get: (_k: string, d?: string) => d } as never);
    await resolver.markSuperseded(db as never, 'knowledge_fact:1', 'knowledge_fact:2');
    expect(sqls.at(-1)).toBe(`UPDATE $winner SET status = 'active' WHERE status = 'competing'`);
  });
});

describe('belief_statement', () => {
  it('a tenant-global caller has no beliefs to phrase', async () => {
    const { surreal } = surrealOver(async () => [[]]);
    expect(await new BeliefStatementWorkService(surreal as never).take('co_a', {})).toBeNull();
  });

  it('replaces the template only while the revision states what it was asked about', async () => {
    const belief = {
      id: 'semantic_belief:1',
      subject: 'Sasha',
      field: 'home city',
      value: 'Porto',
      priorValue: 'Lisbon',
    };
    let current = belief;
    const updates: unknown[] = [];
    const { surreal } = surrealOver(async (sql, params) => {
      if (sql.startsWith('UPDATE')) updates.push(params);
      return [[current]];
    });
    const work = new BeliefStatementWorkService(surreal as never);
    const payload: BeliefsTokenPayload = {
      ...base,
      t: 'belief_statement',
      u: 'u1',
      b: [['semantic_belief:1', pairSignature('Sasha', 'home city', 'Porto', 'Lisbon')]],
    };
    const reply = { beliefs: [{ belief: 'b1', statement: 'Sasha moved from Lisbon to Porto.' }] };
    expect(await work.submit('co_a', payload, reply)).toMatchObject({ phrased: 1, stale: 0 });
    expect(updates).toEqual([
      expect.objectContaining({ text: 'Sasha moved from Lisbon to Porto.' }),
    ]);
    current = { ...belief, value: 'Braga' };
    expect(await work.submit('co_a', payload, reply)).toMatchObject({ phrased: 0, stale: 1 });
  });
});

describe('predicate_semantics', () => {
  it("applies the agent's cardinality through the registry and skips what is no longer pending", async () => {
    let pending = ['gym_plan'];
    const { surreal } = surrealOver(async (sql) =>
      sql.includes('FROM knowledge_predicate')
        ? [pending.map((predicateId) => ({ predicateId }))]
        : [[]],
    );
    const registry = {
      listAll: jest.fn(async () => [
        {
          predicateId: 'gym_plan',
          semantics: 'append_only',
          description: `(auto-proposed as append_only by the ${HARNESS_SEMANTICS_PENDING}; awaiting review.)`,
        },
      ]),
      update: jest.fn(async () => null),
    };
    const work = new PredicateSemanticsWorkService(surreal as never, registry as never);
    const payload: PredicatesTokenPayload = { ...base, t: 'predicate_semantics', q: ['gym_plan'] };
    const reply = { predicates: [{ predicate: 'q1', semantics: 'single_active' }] };
    expect(await work.submit('co_a', payload, reply)).toMatchObject({ singleActive: 1, stale: 0 });
    expect(registry.update).toHaveBeenCalledWith('co_a', 'gym_plan', {
      semantics: 'single_active',
      description: '(auto-proposed as single_active by the harness agent; awaiting review.)',
    });
    pending = [];
    expect(await work.submit('co_a', payload, reply)).toMatchObject({ singleActive: 0, stale: 1 });
  });
});
