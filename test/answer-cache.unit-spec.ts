import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type { SynthesizeResult } from '../src/synthesize/synthesize.types';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';
import {
  ANSWER_CACHE_PROMPT_VERSION,
  AnswerCacheService,
  canonicalDerivedPin,
  computeCacheKey,
  computeProfileHash,
  deterministicSerialize,
  normalizeQuery,
  type AnswerCacheStoreContext,
} from '../src/answer-cache/answer-cache.service';

/**
 * G1 answer cache — key construction + admission + check-on-read
 * rejection matrix, pure/mocked (no DB, no Nest boot). The e2e twin
 * (answer-cache.e2e-spec.ts) covers the wired path.
 */

// ── Key construction ───────────────────────────────────────────────

describe('normalizeQuery', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeQuery('  What   Is\tThe  Plan ')).toBe('what is the plan');
  });

  it('strips trailing punctuation only', () => {
    expect(normalizeQuery('what is the plan?!…')).toBe('what is the plan');
    expect(normalizeQuery('what, is: the plan')).toBe('what, is: the plan');
  });

  it('applies NFC so composed and decomposed unicode share a key', () => {
    expect(normalizeQuery('café')).toBe(normalizeQuery('café'));
  });
});

describe('deterministicSerialize / computeProfileHash', () => {
  it('is insensitive to object key order, sensitive to values', () => {
    expect(deterministicSerialize({ a: 1, b: [2, 3] })).toBe(
      deterministicSerialize({ b: [2, 3], a: 1 }),
    );
    expect(deterministicSerialize({ a: 1 })).not.toBe(
      deterministicSerialize({ a: 2 }),
    );
  });

  it('serializes Sets as sorted arrays (profile.lanes)', () => {
    expect(deterministicSerialize(new Set(['b', 'a']))).toBe(
      deterministicSerialize(new Set(['a', 'b'])),
    );
  });

  it('profile field or knob changes flip the hash', () => {
    const profile = resolveRetrievalProfile();
    const base = computeProfileHash(profile, { guardrails: 'strict' });
    expect(computeProfileHash(profile, { guardrails: 'strict' })).toBe(base);
    expect(computeProfileHash(profile, { guardrails: 'lenient' })).not.toBe(
      base,
    );
    expect(
      computeProfileHash({ ...profile, factBudget: profile.factBudget + 1 }, {
        guardrails: 'strict',
      }),
    ).not.toBe(base);
  });
});

describe('canonicalDerivedPin', () => {
  it('canonicalizes null / single / union pins', () => {
    expect(canonicalDerivedPin(null)).toBe('-');
    expect(canonicalDerivedPin('wd-v3')).toBe('wd-v3');
    expect(canonicalDerivedPin(['b', 'a', 'b'])).toBe('a+b');
  });
});

describe('computeCacheKey', () => {
  const base = {
    companyId: 'co_a',
    profileHash: 'ph1',
    model: 'gpt-4o-mini',
    derivedVersionPin: null,
    query: 'what is the plan',
  };

  it('normalization makes typographic variants share a key', () => {
    expect(computeCacheKey({ ...base, query: '  What IS the   plan?' })).toBe(
      computeCacheKey(base),
    );
  });

  it('differs across tenant / user / profileHash / model / derivedVersion', () => {
    const key = computeCacheKey(base);
    expect(computeCacheKey({ ...base, companyId: 'co_b' })).not.toBe(key);
    expect(computeCacheKey({ ...base, userId: 'user_a' })).not.toBe(key);
    expect(computeCacheKey({ ...base, profileHash: 'ph2' })).not.toBe(key);
    expect(computeCacheKey({ ...base, model: 'gpt-5-mini' })).not.toBe(key);
    expect(
      computeCacheKey({ ...base, derivedVersionPin: 'wd-v3' }),
    ).not.toBe(key);
    // Two user scopes never collide with each other either.
    expect(computeCacheKey({ ...base, userId: 'user_a' })).not.toBe(
      computeCacheKey({ ...base, userId: 'user_b' }),
    );
  });

  it('bakes the prompt version in (a bump misses every old entry)', () => {
    expect(ANSWER_CACHE_PROMPT_VERSION).toBe(1);
  });
});

// ── Service behavior (mocked Surreal) ──────────────────────────────

interface QueryCall {
  sql: string;
  params: Record<string, unknown>;
}

function makeHarness(opts: {
  flag?: string;
  ttl?: string;
  cacheRow?: Record<string, unknown> | null;
  factRows?: Array<Record<string, unknown>>;
  entityRows?: Array<Record<string, unknown>>;
}) {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params: Record<string, unknown> = {}) => {
      calls.push({ sql, params });
      if (/FROM knowledge_fact/.test(sql)) {
        return [opts.factRows ?? [], opts.entityRows ?? []];
      }
      if (/^\s*SELECT/.test(sql)) {
        return [opts.cacheRow ? [opts.cacheRow] : []];
      }
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: typeof db) => unknown) => fn(db),
    withScopedCompany: async (
      _c: string,
      _s: string[],
      fn: (d: typeof db) => unknown,
    ) => fn(db),
  } as unknown as SurrealService;
  const config = {
    get: (key: string, dflt?: string) =>
      key === 'SYNTHESIZE_ANSWER_CACHE'
        ? (opts.flag ?? '1')
        : key === 'SYNTHESIZE_ANSWER_CACHE_TTL_HOURS'
          ? (opts.ttl ?? dflt)
          : dflt,
  } as unknown as ConfigService;
  const outcomes: string[] = [];
  const metrics = {
    countAnswerCache: (o: string) => outcomes.push(o),
  } as unknown as MetricsService;
  const svc = new AnswerCacheService(
    surreal,
    config,
    undefined,
    undefined,
    metrics,
  );
  return { svc, calls, outcomes };
}

const PROFILE = resolveRetrievalProfile();

function beginArgs(overrides: Partial<SynthesizeDto> = {}) {
  return {
    companyId: 'co_test',
    dto: { query: 'what tier is acme', ...overrides } as SynthesizeDto,
    callerScopes: ['brain:read'],
    profile: PROFILE,
    model: 'gpt-4o-mini',
    guardrails: 'strict',
  };
}

function liveCacheRow(over: Record<string, unknown> = {}) {
  return {
    id: 'answer_cache:abc',
    answer: 'Acme is gold tier.',
    citedFactIds: ['knowledge_fact:f1'],
    entityIds: ['knowledge_entity:e1'],
    expiresAt: new Date(Date.now() + 3_600_000),
    invalidatedAt: null,
    ...over,
  };
}

function activeFact(over: Record<string, unknown> = {}) {
  return {
    id: 'knowledge_fact:f1',
    predicate: 'tier',
    object: 'gold',
    entityId: 'knowledge_entity:e1',
    status: 'active',
    validUntil: null,
    retractedAt: null,
    userId: null,
    ...over,
  };
}

const ENV_KEYS = ['RETRIEVAL_DERIVED_VERSION', 'RETRIEVAL_DERIVED_VERSIONS'];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('AnswerCacheService.begin — serving', () => {
  it('flag off → undefined, no queries, no metrics', async () => {
    const h = makeHarness({ flag: '0' });
    expect(await h.svc.begin(beginArgs())).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(h.outcomes).toEqual([]);
  });

  it('explain=true bypasses (no lookup, no store context)', async () => {
    const h = makeHarness({});
    expect(await h.svc.begin(beginArgs({ explain: true }))).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(h.outcomes).toEqual(['bypass']);
  });

  it('no row → miss with a store context', async () => {
    const h = makeHarness({ cacheRow: null });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit).toBeUndefined();
    expect(out?.ctx?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(h.outcomes).toEqual(['miss']);
  });

  it('TTL-expired row → miss (no invalidation write)', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ expiresAt: new Date(Date.now() - 1000) }),
    });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit).toBeUndefined();
    expect(h.outcomes).toEqual(['miss']);
    expect(
      h.calls.some((c) => /invalidatedAt = time::now\(\)/.test(c.sql)),
    ).toBe(false);
  });

  it('live row + all-active facts → hit, hitCount increment, cached:true', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
    });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit).toBeDefined();
    expect(out?.hit?.cached).toBe(true);
    expect(out?.hit?.answer).toBe('Acme is gold tier.');
    expect(out?.hit?.citations).toEqual([
      {
        factId: 'knowledge_fact:f1',
        entityId: 'knowledge_entity:e1',
        canonicalName: 'Acme',
        predicate: 'tier',
        object: 'gold',
      },
    ]);
    expect(out?.hit?.results).toEqual([]);
    expect(h.outcomes).toEqual(['hit']);
    const touch = h.calls.find((c) => /hitCount \+= 1/.test(c.sql));
    expect(touch).toBeDefined();
    expect(/lastServedAt = time::now\(\)/.test(touch!.sql)).toBe(true);
  });

  it('tenant + user double-fence in the lookup WHERE clause', async () => {
    const h = makeHarness({ cacheRow: null });
    await h.svc.begin(beginArgs({ userId: 'user_a' }));
    const lookup = h.calls[0]!;
    expect(lookup.sql).toContain('companyId = $companyId');
    expect(lookup.sql).toContain('userId = $userId');
    expect(lookup.params.userId).toBe('user_a');
    const h2 = makeHarness({ cacheRow: null });
    await h2.svc.begin(beginArgs());
    expect(h2.calls[0]!.sql).toContain('userId IS NONE');
  });
});

describe('AnswerCacheService.begin — check-on-read rejection matrix', () => {
  async function reject(
    factRows: Array<Record<string, unknown>>,
    row = liveCacheRow(),
  ) {
    const h = makeHarness({
      cacheRow: row,
      factRows,
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
    });
    const out = await h.svc.begin(beginArgs());
    const invalidation = h.calls.find((c) =>
      /invalidatedAt = time::now\(\)/.test(c.sql),
    );
    return { out, invalidation, outcomes: h.outcomes };
  }

  it('superseded fact → rejected_stale, cause=superseded, miss', async () => {
    const { out, invalidation, outcomes } = await reject([
      activeFact({ status: 'superseded' }),
    ]);
    expect(out?.hit).toBeUndefined();
    expect(out?.ctx).toBeDefined();
    expect(invalidation?.params.cause).toBe('superseded');
    expect(outcomes).toEqual(['rejected_stale']);
  });

  it('retracted fact → cause=retracted', async () => {
    const { invalidation } = await reject([
      activeFact({ status: 'retracted' }),
    ]);
    expect(invalidation?.params.cause).toBe('retracted');
  });

  it('retractedAt set (status not yet flipped) → cause=retracted', async () => {
    const { invalidation } = await reject([
      activeFact({ retractedAt: new Date() }),
    ]);
    expect(invalidation?.params.cause).toBe('retracted');
  });

  it('validUntil in the past → cause=expired_validity', async () => {
    const { invalidation } = await reject([
      activeFact({ validUntil: new Date(Date.now() - 1000) }),
    ]);
    expect(invalidation?.params.cause).toBe('expired_validity');
  });

  it('cited fact missing entirely → cause=missing', async () => {
    const { invalidation } = await reject([]);
    expect(invalidation?.params.cause).toBe('missing');
  });

  it('non-servable lifecycle state (compacted) fails closed as missing', async () => {
    const { invalidation } = await reject([
      activeFact({ status: 'compacted' }),
    ]);
    expect(invalidation?.params.cause).toBe('missing');
  });

  it('one dead fact among live ones still rejects (EVERY-fact gate)', async () => {
    const row = liveCacheRow({
      citedFactIds: ['knowledge_fact:f1', 'knowledge_fact:f2'],
    });
    const { invalidation, outcomes } = await reject(
      [
        activeFact(),
        activeFact({ id: 'knowledge_fact:f2', status: 'superseded' }),
      ],
      row,
    );
    expect(invalidation?.params.cause).toBe('superseded');
    expect(outcomes).toEqual(['rejected_stale']);
  });
});

describe('AnswerCacheService.admit — admission rules', () => {
  const ctx: AnswerCacheStoreContext = {
    key: 'a'.repeat(64),
    companyId: 'co_test',
    profileHash: 'ph',
    model: 'gpt-4o-mini',
    normalizedQuery: 'what tier is acme',
  };
  const grounded: SynthesizeResult = {
    answer: 'Acme is gold tier.',
    citations: [
      {
        factId: 'knowledge_fact:f1',
        entityId: 'knowledge_entity:e1',
        canonicalName: 'Acme',
        predicate: 'tier',
        object: 'gold',
      },
    ],
    results: [],
  };

  it('supported + cited + no reason → stored (UPSERT, hitCount reset)', async () => {
    const h = makeHarness({});
    await h.svc.admit(ctx, grounded, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql));
    expect(upsert).toBeDefined();
    expect(upsert!.params.citedFactIds).toEqual(['knowledge_fact:f1']);
    expect(upsert!.params.entityIds).toEqual(['knowledge_entity:e1']);
    expect(upsert!.params.promptVersion).toBe(ANSWER_CACHE_PROMPT_VERSION);
    expect(upsert!.sql).toContain('hitCount: 0');
    expect(upsert!.sql).toContain('invalidatedAt: NONE');
    expect(h.outcomes).toEqual(['stored']);
  });

  it('honors the TTL env for expiresAt', async () => {
    const h = makeHarness({ ttl: '2' });
    const before = Date.now();
    await h.svc.admit(ctx, grounded, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const expiresAt = (upsert.params.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(before + 2 * 3_600_000 + 60_000);
  });

  it.each([
    ['partial verdict', grounded, 'partial'],
    ['unsupported verdict', grounded, 'unsupported'],
    ['abstention (null answer)', { ...grounded, answer: null }, 'supported'],
    [
      'reason-tagged return (low_coverage)',
      { ...grounded, reason: 'low_coverage' },
      'supported',
    ],
    [
      'zero citations',
      { ...grounded, citations: [] },
      'supported',
    ],
  ] as Array<[string, SynthesizeResult, 'supported' | 'partial' | 'unsupported']>)(
    'never caches: %s',
    async (_name, result, verdict) => {
      const h = makeHarness({});
      await h.svc.admit(ctx, result, verdict);
      expect(h.calls).toHaveLength(0);
      expect(h.outcomes).toEqual([]);
    },
  );
});
