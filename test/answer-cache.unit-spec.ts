import type { ConfigService } from '@nestjs/config';
import type { SurrealService } from '../src/db/surreal.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import type { PredicateRegistryService } from '../src/ai/predicate-registry.service';
import type { SynthesizeDto } from '../src/synthesize/dto/synthesize.dto';
import type { SynthesizeResult } from '../src/synthesize/synthesize.types';
import { resolveRetrievalProfile } from '../src/search/retrieval-profile';
import {
  ANSWER_CACHE_PROMPT_VERSION,
  AnswerCacheService,
  canonicalDerivedPin,
  computeCacheKey,
  computeProfileHash,
  computeScopeHash,
  dependenciesOf,
  deterministicSerialize,
  normalizeQuery,
  type AnswerCacheStoreContext,
  type CachedDependencyKind,
} from '../src/answer-cache/answer-cache.service';
import { mediaPiiAllowed } from '../src/common/media-pii';
import { declaredModalitySection, modalitiesChecksum } from '../src/ai/domain-packs';
import { sceneStamp } from '../src/synthesize/evidence-visibility';

/**
 * G1 answer cache — key construction + admission + check-on-read
 * rejection matrix, pure/mocked (no DB, no Nest boot). The e2e twin
 * (answer-cache.e2e-spec.ts) covers the wired path.
 */

// ── Key construction ───────────────────────────────────────────────

describe('normalizeQuery', () => {
  it('collapses whitespace and trims, preserving case', () => {
    // F1: NFC + whitespace-collapse ONLY — case is preserved.
    expect(normalizeQuery('  What   Is\tThe  Plan ')).toBe('What Is The Plan');
  });

  it('preserves case so distinct-case identifiers do not collide', () => {
    // getUserById vs getuserbyid are different symbols — must not fold.
    expect(normalizeQuery('getUserById')).toBe('getUserById');
    expect(normalizeQuery('getUserById')).not.toBe(normalizeQuery('getuserbyid'));
  });

  it('preserves punctuation (no trailing-punctuation stripping)', () => {
    expect(normalizeQuery('what is the plan?!…')).toBe('what is the plan?!…');
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
    expect(deterministicSerialize({ a: 1 })).not.toBe(deterministicSerialize({ a: 2 }));
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
    expect(computeProfileHash(profile, { guardrails: 'lenient' })).not.toBe(base);
    expect(
      computeProfileHash(
        { ...profile, factBudget: profile.factBudget + 1 },
        {
          guardrails: 'strict',
        },
      ),
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

describe('computeScopeHash', () => {
  it('is order- and duplicate-insensitive, and separates different rights', () => {
    expect(computeScopeHash(['brain:read', 'brain:read_media'])).toBe(
      computeScopeHash(['brain:read_media', 'brain:read', 'brain:read']),
    );
    expect(computeScopeHash(['brain:read'])).not.toBe(
      computeScopeHash(['brain:read', 'brain:read_media']),
    );
    expect(computeScopeHash([])).not.toBe(computeScopeHash(['brain:read']));
  });
});

describe('computeCacheKey', () => {
  const base = {
    companyId: 'co_a',
    profileHash: 'ph1',
    model: 'gpt-4o-mini',
    derivedVersionPin: null,
    scopeHash: computeScopeHash(['brain:read']),
    query: 'what is the plan',
  };

  it('whitespace-only variants share a key (NFC + whitespace collapse)', () => {
    expect(computeCacheKey({ ...base, query: '  what   is the  plan  ' })).toBe(
      computeCacheKey(base),
    );
  });

  it('case-only variants produce DIFFERENT keys (F1: no case-folding)', () => {
    const key = computeCacheKey(base);
    expect(computeCacheKey({ ...base, query: 'What IS the plan' })).not.toBe(key);
    expect(computeCacheKey({ ...base, query: 'getUserById' })).not.toBe(
      computeCacheKey({ ...base, query: 'getuserbyid' }),
    );
  });

  it('trailing-punctuation variants produce DIFFERENT keys (no strip)', () => {
    expect(computeCacheKey({ ...base, query: 'what is the plan?' })).not.toBe(
      computeCacheKey(base),
    );
  });

  it('differs across tenant / user / scopeHash / profileHash / model / derivedVersion', () => {
    const key = computeCacheKey(base);
    expect(computeCacheKey({ ...base, companyId: 'co_b' })).not.toBe(key);
    // Round-2 audit F1 (half b): rights partition the key, so a
    // brain:read_media answer and a brain:read answer to the same
    // question can never share an entry.
    expect(
      computeCacheKey({ ...base, scopeHash: computeScopeHash(['brain:read', 'brain:read_media']) }),
    ).not.toBe(key);
    expect(computeCacheKey({ ...base, userId: 'user_a' })).not.toBe(key);
    expect(computeCacheKey({ ...base, profileHash: 'ph2' })).not.toBe(key);
    expect(computeCacheKey({ ...base, model: 'gpt-5-mini' })).not.toBe(key);
    expect(computeCacheKey({ ...base, derivedVersionPin: 'wd-v3' })).not.toBe(key);
    // Two user scopes never collide with each other either.
    expect(computeCacheKey({ ...base, userId: 'user_a' })).not.toBe(
      computeCacheKey({ ...base, userId: 'user_b' }),
    );
  });

  it('bakes the prompt version in (a bump misses every old entry)', () => {
    // 2 = 0136: a row carries its typed non-fact dependencies, so every
    // pre-0136 entry (which cannot be revalidated) misses by key.
    expect(ANSWER_CACHE_PROMPT_VERSION).toBe(2);
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
  enumTtl?: string;
  enumMinCitations?: string;
  cacheRow?: Record<string, unknown> | null;
  factRows?: Array<Record<string, unknown>>;
  entityRows?: Array<Record<string, unknown>>;
  /** Freshness-probe candidate rows (3rd statement of the check-on-read
   *  batch) — active facts on a cited entity newer than the answer. */
  probeRows?: Array<Record<string, unknown>>;
  /** Predicate the row-policy fences off (requiresScope the caller lacks)
   *  — used to model DB rows that survive the SQL scope gate but are then
   *  discarded by the JS row-policy (the gap-1 cap-before-scope vector). */
  deniedPredicate?: string;
  /** 0136: the live rows behind non-fact dependencies, per kind — what the
   *  per-kind dependency SELECTs (one batch, kinds in declared order)
   *  return at admission and on read. Absent kind ⇒ no rows ⇒ 'missing'. */
  dependencyRows?: Partial<Record<CachedDependencyKind, Array<Record<string, unknown>>>>;
  /** Live `scenes` projection version — the scene fence's world clause.
   *  Absent ⇒ no live world ⇒ a scene dependency is invisible. */
  sceneWorld?: string;
  /** Whether the tenant holds current 0112 modality consent — the
   *  fragment fence's lane-level clause. Default true (the fragment
   *  tests are about the row fences); false models a revocation. */
  mediaConsent?: boolean;
}) {
  const calls: QueryCall[] = [];
  const DEP_TABLES: Record<CachedDependencyKind, string> = {
    belief: 'FROM semantic_belief',
    episode: 'FROM episode ',
    fragment: 'FROM evidence_fragment',
    scene: 'FROM memory_episode',
  };
  /** The 0112 consent row shape hasCurrentModalityConsent accepts. */
  const CONSENTED_PACK = {
    manifest: { memoryModel: { modalities: ['text', 'image'] } },
    acceptedModalities: true,
    acceptedModalitiesChecksum: modalitiesChecksum(
      declaredModalitySection({ memoryModel: { modalities: ['text', 'image'] } } as never),
    ),
  };
  const db = {
    query: async (sql: string, params: Record<string, unknown> = {}) => {
      calls.push({ sql, params });
      // The dependency-fence world read: up to two statements (live scene
      // world, then the tenant's consent rows) in the order the service
      // emits them.
      if (/FROM projection|FROM domain_pack/.test(sql)) {
        const out: unknown[] = [];
        if (/FROM projection/.test(sql)) out.push(opts.sceneWorld ? [opts.sceneWorld] : []);
        if (/FROM domain_pack/.test(sql)) {
          out.push(opts.mediaConsent === false ? [] : [CONSENTED_PACK]);
        }
        return out;
      }
      const depKinds = (Object.keys(DEP_TABLES) as CachedDependencyKind[]).filter((k) =>
        sql.includes(DEP_TABLES[k]),
      );
      if (depKinds.length > 0) {
        // One result slot per kind present, in the order the service emits
        // the statements (the declared kind order).
        return depKinds.map((k) => opts.dependencyRows?.[k] ?? []);
      }
      if (/FROM knowledge_fact/.test(sql)) {
        // check-on-read batch: [cited facts, entity names, newer-fact probe].
        // Model the DB-side LIMIT on the probe so cap-before-scope behaves
        // like the real query: only the first N candidate rows reach JS,
        // BEFORE the row-policy fences run (the gap-1 regression surface).
        const probe = opts.probeRows ?? [];
        const limit = /LIMIT (\d+)/.exec(sql);
        const capped = limit ? probe.slice(0, parseInt(limit[1]!, 10)) : probe;
        return [opts.factRows ?? [], opts.entityRows ?? [], capped];
      }
      if (/^\s*SELECT/.test(sql)) {
        return [opts.cacheRow ? [opts.cacheRow] : []];
      }
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: typeof db) => unknown) => fn(db),
    withScopedCompany: async (_c: string, _s: string[], fn: (d: typeof db) => unknown) => fn(db),
  } as unknown as SurrealService;
  const config = {
    get: (key: string, dflt?: string) => {
      switch (key) {
        case 'SYNTHESIZE_ANSWER_CACHE':
          return opts.flag ?? '1';
        case 'SYNTHESIZE_ANSWER_CACHE_TTL_HOURS':
          return opts.ttl ?? dflt;
        case 'SYNTHESIZE_ANSWER_CACHE_ENUM_TTL_HOURS':
          return opts.enumTtl ?? dflt;
        case 'SYNTHESIZE_ANSWER_CACHE_ENUM_MIN_CITATIONS':
          return opts.enumMinCitations ?? dflt;
        default:
          return dflt;
      }
    },
  } as unknown as ConfigService;
  const outcomes: string[] = [];
  const metrics = {
    countAnswerCache: (o: string) => outcomes.push(o),
  } as unknown as MetricsService;
  // Registry-backed row policy: mark deniedPredicate as requiring a scope
  // the caller (['brain:read']) does not hold, so makeRowPolicyFilter's
  // predicate-scope gate discards those rows in JS — exactly the fence that
  // runs AFTER the DB LIMIT. Absent → static seed policy (all-visible).
  const predicateRegistry = opts.deniedPredicate
    ? ({
        rowPolicyLookup: async (_c: string) => (predicate: string) =>
          predicate === opts.deniedPredicate
            ? { requiresScope: 'brain:read_pii', piiClass: 'sensitive' }
            : { piiClass: 'none' },
      } as unknown as PredicateRegistryService)
    : undefined;
  const svc = new AnswerCacheService(surreal, config, undefined, predicateRegistry, metrics);
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
    // 0136: a fact-only answer carries an EMPTY dependency list (an absent
    // list is a pre-0136 row and fails closed — see the dependency block).
    dependencies: [],
    createdAt: new Date(Date.now() - 3_600_000),
    expiresAt: new Date(Date.now() + 3_600_000),
    invalidatedAt: null,
    ...over,
  };
}

/** A newer active fact on the cited entity — the additive-write signal.
 *  (The mocked DB returns these verbatim as the probe result; the real
 *  `recordedAt > createdAt` filtering is exercised in the e2e twin.) */
function newerFact(over: Record<string, unknown> = {}) {
  return {
    id: 'knowledge_fact:f2',
    predicate: 'pet',
    object: 'dog',
    entityId: 'knowledge_entity:e1',
    status: 'active',
    userId: null,
    ...over,
  };
}

/** The live `scenes` world every scene fixture belongs to. */
const WORLD = 'scene-segmenter-v1';

/**
 * A fragment row as the widened dependency SELECT returns it: the
 * lifecycle stamp PLUS the fence columns the lane reads. `piiClasses: []`
 * is the affirmatively-clean state — the only one a plain `brain:read`
 * caller may see (src/common/media-pii.ts).
 */
function liveFragment(over: Record<string, unknown> = {}) {
  return {
    id: 'evidence_fragment:fr1',
    quarantineStatus: 'clean',
    piiClasses: [],
    assetUserId: null,
    assetAvailability: 'stored',
    ...over,
  };
}

/** A scene row as the widened dependency SELECT returns it. */
function liveScene(over: Record<string, unknown> = {}) {
  return {
    id: 'memory_episode:s1',
    gist: 'moved to A',
    enrichedGist: null,
    unexpectedDetails: null,
    userId: 'alice',
    userIds: ['alice'],
    piiClass: null,
    segmenterVersion: WORLD,
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
    expect(h.calls.some((c) => /invalidatedAt = time::now\(\)/.test(c.sql))).toBe(false);
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
  async function reject(factRows: Array<Record<string, unknown>>, row = liveCacheRow()) {
    const h = makeHarness({
      cacheRow: row,
      factRows,
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
    });
    const out = await h.svc.begin(beginArgs());
    const invalidation = h.calls.find((c) => /invalidatedAt = time::now\(\)/.test(c.sql));
    return { out, invalidation, outcomes: h.outcomes };
  }

  it('superseded fact → rejected_stale, cause=superseded, miss', async () => {
    const { out, invalidation, outcomes } = await reject([activeFact({ status: 'superseded' })]);
    expect(out?.hit).toBeUndefined();
    expect(out?.ctx).toBeDefined();
    expect(invalidation?.params.cause).toBe('superseded');
    expect(outcomes).toEqual(['rejected_stale']);
  });

  it('retracted fact → cause=retracted', async () => {
    const { invalidation } = await reject([activeFact({ status: 'retracted' })]);
    expect(invalidation?.params.cause).toBe('retracted');
  });

  it('retractedAt set (status not yet flipped) → cause=retracted', async () => {
    const { invalidation } = await reject([activeFact({ retractedAt: new Date() })]);
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
    const { invalidation } = await reject([activeFact({ status: 'compacted' })]);
    expect(invalidation?.params.cause).toBe('missing');
  });

  it('one dead fact among live ones still rejects (EVERY-fact gate)', async () => {
    const row = liveCacheRow({
      citedFactIds: ['knowledge_fact:f1', 'knowledge_fact:f2'],
    });
    const { invalidation, outcomes } = await reject(
      [activeFact(), activeFact({ id: 'knowledge_fact:f2', status: 'superseded' })],
      row,
    );
    expect(invalidation?.params.cause).toBe('superseded');
    expect(outcomes).toEqual(['rejected_stale']);
  });
});

describe('AnswerCacheService.begin — additive-write freshness probe (F1)', () => {
  it('newer active fact on a cited entity → rejected_stale, cause=newer_fact, miss', async () => {
    // The cat→dog case: the cited fact ('cat') stays active, but a new
    // ('dog') fact landed on the same entity → the cached answer is stale.
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()], // cited fact still active
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
      probeRows: [newerFact()], // additive write on the cited entity
    });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit).toBeUndefined();
    expect(out?.ctx).toBeDefined(); // falls through to fresh synthesis
    const invalidation = h.calls.find((c) => /invalidatedAt = time::now\(\)/.test(c.sql));
    expect(invalidation?.params.cause).toBe('newer_fact');
    expect(h.outcomes).toEqual(['rejected_stale']);
  });

  it('no newer fact → serves the hit (probe never over-invalidates)', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
      probeRows: [], // no additive write
    });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit?.cached).toBe(true);
    expect(out?.hit?.answer).toBe('Acme is gold tier.');
    expect(h.outcomes).toEqual(['hit']);
    expect(h.calls.some((c) => /invalidatedAt = time::now\(\)/.test(c.sql))).toBe(false);
  });

  it('probe query scopes to the answer partition (user-pinned → global + own)', async () => {
    // Needs a live row so check-on-read (and its probe) actually runs.
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
    });
    await h.svc.begin(beginArgs({ userId: 'user_a' }));
    const probe = h.calls.find((c) => /recordedAt > \$answerCreatedAt/.test(c.sql));
    expect(probe).toBeDefined();
    // A user-pinned answer's probe sees global + its OWN facts only — a
    // new user_b fact is out of scope and cannot cross-invalidate it.
    expect(probe!.sql).toContain('(userId IS NONE OR userId = $probeScopeUserId)');
    expect(probe!.params.probeScopeUserId).toBe('user_a');
  });

  it('probe query scopes a tenant-global answer to global facts only', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
    });
    await h.svc.begin(beginArgs()); // no userId → tenant-global (M2M)
    const probe = h.calls.find((c) => /recordedAt > \$answerCreatedAt/.test(c.sql));
    expect(probe).toBeDefined();
    expect(probe!.sql).toContain('AND userId IS NONE');
    expect(probe!.sql).not.toContain('$probeScopeUserId');
  });

  it('a more specific lifecycle cause wins over newer_fact', async () => {
    // A retracted cited fact AND a newer fact: the retraction is reported
    // (the probe never runs once a cited fact already failed).
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact({ status: 'retracted' })],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
      probeRows: [newerFact()],
    });
    await h.svc.begin(beginArgs());
    const invalidation = h.calls.find((c) => /invalidatedAt = time::now\(\)/.test(c.sql));
    expect(invalidation?.params.cause).toBe('retracted');
  });

  it('a visible newer fact is NOT hidden behind >cap row-policy-fenced rows (gap 1)', async () => {
    // The cap-before-scope bug: the DB LIMIT precedes the JS row-policy, so
    // 30 newer facts the row-policy will fence (predicate 'secret',
    // requiresScope the caller lacks) crowd the front of the probe result,
    // then ONE genuinely visible newer fact ('plan'). Under a naive
    // `LIMIT cap` the DB would return only the 25 fenced rows and the
    // visible one would never be seen → STALE HIT. The cap+1 fetch + the
    // full-page fail-closed guard invalidates instead.
    const fenced = Array.from({ length: 30 }, (_, i) =>
      newerFact({ id: `knowledge_fact:secret_${i}`, predicate: 'secret', object: 'x' }),
    );
    const visible = newerFact({
      id: 'knowledge_fact:plan1',
      predicate: 'plan',
      object: 'premium',
    });
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()], // cited 'tier' fact stays active + visible
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
      probeRows: [...fenced, visible],
      deniedPredicate: 'secret',
    });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit).toBeUndefined(); // MUST NOT serve the stale answer
    expect(out?.ctx).toBeDefined(); // falls through to fresh synthesis
    const invalidation = h.calls.find((c) => /invalidatedAt = time::now\(\)/.test(c.sql));
    expect(invalidation?.params.cause).toBe('newer_fact');
    expect(h.outcomes).toEqual(['rejected_stale']);
    // The probe fetches cap + 1 (26) so a full page can fail closed.
    const probe = h.calls.find((c) => /recordedAt > \$answerCreatedAt/.test(c.sql))!;
    expect(probe.sql).toContain('LIMIT 26');
  });

  it('row-policy-fenced newer facts UNDER the cap do not over-invalidate (serves)', async () => {
    // A few newer facts, ALL row-policy-denied and none visible: the probe
    // must NOT fire (they are invisible to this caller, never part of its
    // answer), and the count is under the cap so the page is exhaustive —
    // the answer genuinely serves. Confirms the fences still gate the probe.
    const fenced = Array.from({ length: 3 }, (_, i) =>
      newerFact({ id: `knowledge_fact:secret_${i}`, predicate: 'secret' }),
    );
    const h = makeHarness({
      cacheRow: liveCacheRow(),
      factRows: [activeFact()],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
      probeRows: fenced,
      deniedPredicate: 'secret',
    });
    const out = await h.svc.begin(beginArgs());
    expect(out?.hit?.cached).toBe(true);
    expect(h.outcomes).toEqual(['hit']);
    expect(h.calls.some((c) => /invalidatedAt = time::now\(\)/.test(c.sql))).toBe(false);
  });
});

describe('AnswerCacheService.admit — admission rules', () => {
  const ctx: AnswerCacheStoreContext = {
    key: 'a'.repeat(64),
    companyId: 'co_test',
    callerScopes: ['brain:read'],
    profileHash: 'ph',
    model: 'gpt-4o-mini',
    normalizedQuery: 'what tier is acme',
    isEnumeration: false,
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

  it('open-enumeration answers get the shorter enum TTL (min of the two)', async () => {
    const enumCtx: AnswerCacheStoreContext = { ...ctx, isEnumeration: true };
    const h = makeHarness({ ttl: '24', enumTtl: '1' });
    const before = Date.now();
    await h.svc.admit(enumCtx, grounded, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const expiresAt = (upsert.params.expiresAt as Date).getTime();
    // 1h enum TTL, not the 24h regular one.
    expect(expiresAt).toBeLessThanOrEqual(before + 1 * 3_600_000 + 60_000);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 1 * 3_600_000 - 5_000);
  });

  it('new-entity residual: a regular answer still carries the bounded regular TTL', async () => {
    // The freshness probe only scans an answer's CITED entities, so a fact
    // on a BRAND-NEW entity can't be probed without re-retrieval; that
    // residual is bounded — for every answer — ONLY by the regular TTL. A
    // plain (non-enum, few-citation) answer must therefore still be admitted
    // with a finite expiresAt == the regular TTL window (the new-entity
    // staleness bound), never an unbounded serve.
    const h = makeHarness({ ttl: '24' });
    const before = Date.now();
    await h.svc.admit(ctx, grounded, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const expiresAt = (upsert.params.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(before + 24 * 3_600_000 + 60_000);
  });

  it('language-agnostic enum guard: a broad many-citation answer gets the short TTL (gap 3)', async () => {
    // ctx.isEnumeration is FALSE — the query missed the English enum regex
    // (e.g. a non-English "list all X"). But the ANSWER enumerated many
    // items, so the cited-fact-count signal (>= threshold) drops it to the
    // short enum TTL with NO query-language regex involved.
    const broad: SynthesizeResult = {
      answer: 'Six items: a, b, c, d, e, f.',
      citations: Array.from({ length: 6 }, (_, i) => ({
        factId: `knowledge_fact:f${i}`,
        entityId: `knowledge_entity:e${i}`,
        canonicalName: `E${i}`,
        predicate: 'item',
        object: `v${i}`,
      })),
      results: [],
    };
    const h = makeHarness({ ttl: '24', enumTtl: '1', enumMinCitations: '5' });
    const before = Date.now();
    await h.svc.admit({ ...ctx, isEnumeration: false }, broad, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const expiresAt = (upsert.params.expiresAt as Date).getTime();
    // 1h short TTL, not the 24h regular one — the language-agnostic path.
    expect(expiresAt).toBeLessThanOrEqual(before + 1 * 3_600_000 + 60_000);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 1 * 3_600_000 - 5_000);
  });

  it('below the citation threshold a non-enum answer keeps the regular TTL', async () => {
    const small: SynthesizeResult = {
      answer: 'Two: a, b.',
      citations: Array.from({ length: 2 }, (_, i) => ({
        factId: `knowledge_fact:f${i}`,
        entityId: `knowledge_entity:e${i}`,
        canonicalName: `E${i}`,
        predicate: 'item',
        object: `v${i}`,
      })),
      results: [],
    };
    const h = makeHarness({ ttl: '24', enumTtl: '1', enumMinCitations: '5' });
    const before = Date.now();
    await h.svc.admit({ ...ctx, isEnumeration: false }, small, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const expiresAt = (upsert.params.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(before + 24 * 3_600_000 + 60_000);
  });

  it('enum TTL is clamped to never exceed the regular TTL', async () => {
    // Operator sets enum TTL LONGER than regular → min() keeps regular.
    const enumCtx: AnswerCacheStoreContext = { ...ctx, isEnumeration: true };
    const h = makeHarness({ ttl: '2', enumTtl: '9' });
    const before = Date.now();
    await h.svc.admit(enumCtx, grounded, 'supported');
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const expiresAt = (upsert.params.expiresAt as Date).getTime();
    expect(expiresAt).toBeLessThanOrEqual(before + 2 * 3_600_000 + 60_000);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 5_000);
  });

  it.each([
    ['partial verdict', grounded, 'partial'],
    ['unsupported verdict', grounded, 'unsupported'],
    ['abstention (null answer)', { ...grounded, answer: null }, 'supported'],
    ['reason-tagged return (low_coverage)', { ...grounded, reason: 'low_coverage' }, 'supported'],
    ['zero citations', { ...grounded, citations: [] }, 'supported'],
    // FOVEA_L3_EPISODE_CITATIONS: an episode-only-cited L3 answer (zero
    // FACT citations) is DELIBERATELY not admitted — check-on-read cannot
    // invalidate episode citations, so caching it would be
    // uninvalidatable (see admit()'s docblock).
    [
      'episode-only-cited (evidence citations, zero fact citations)',
      {
        ...grounded,
        citations: [],
        evidenceCitations: [{ episodeId: 'episode:ep1', conversationId: 'conv1' }],
      },
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

// ── 0136: every dependency, not only the facts (audit F3) ──────────

describe('dependenciesOf — the typed dependency set of an answer', () => {
  it('maps each evidence arm to its kind, de-duplicates, orders by declared kind', () => {
    expect(
      dependenciesOf([
        { sceneId: 'memory_episode:s1' },
        { beliefId: 'semantic_belief:b1', excerpt: 'x' },
        { episodeId: 'episode:e1', conversationId: 'c1' },
        { fragmentId: 'evidence_fragment:f1', assetId: 'evidence_asset:a1' },
        { beliefId: 'semantic_belief:b1' },
      ]),
    ).toEqual([
      { kind: 'belief', id: 'semantic_belief:b1' },
      { kind: 'episode', id: 'episode:e1' },
      { kind: 'fragment', id: 'evidence_fragment:f1' },
      { kind: 'scene', id: 'memory_episode:s1' },
    ]);
  });

  it('no evidence citations ⇒ an empty (trackable) set', () => {
    expect(dependenciesOf(undefined)).toEqual([]);
    expect(dependenciesOf([])).toEqual([]);
  });

  it('a citation with no trackable arm ⇒ null (untrackable, blocks admission)', () => {
    expect(dependenciesOf([{ beliefId: 'semantic_belief:b1' }, {}])).toBeNull();
    // Not a record id — 3.x cannot bind it, so it can never be revalidated.
    expect(dependenciesOf([{ beliefId: 'b1' }])).toBeNull();
  });
});

describe('AnswerCacheService.admit — dependencies are stamped, or the answer is not cached', () => {
  const ctx: AnswerCacheStoreContext = {
    key: 'b'.repeat(64),
    companyId: 'co_test',
    // A belief / scene arm can only exist on a USER-SCOPED answer: both
    // lanes are scoped-user-only, so an unscoped ctx models a state the
    // serving path cannot produce.
    userId: 'alice',
    callerScopes: ['brain:read'],
    profileHash: 'ph',
    model: 'gpt-4o-mini',
    normalizedQuery: 'where does alice live and work',
    isEnumeration: false,
  };
  /** The audit's repro: one fact (employer) plus one belief (residence). */
  const mixed: SynthesizeResult = {
    answer: 'Alice lives in A and works at Acme.',
    citations: [
      {
        factId: 'knowledge_fact:f',
        entityId: 'knowledge_entity:e',
        canonicalName: 'Alice',
        predicate: 'employer',
        object: 'Acme',
      },
    ],
    evidenceCitations: [{ beliefId: 'semantic_belief:old', excerpt: 'Alice — residence: A' }],
    results: [],
  };
  const liveBelief = (over: Record<string, unknown> = {}) => ({
    id: 'semantic_belief:old',
    revision: 3,
    status: 'active',
    supersededBy: null,
    validUntil: null,
    userId: 'alice',
    ...over,
  });

  it('audit F3 repro: a mixed fact+belief answer is admitted WITH the belief as a stamped dependency', async () => {
    const h = makeHarness({ dependencyRows: { belief: [liveBelief()] } });
    await h.svc.admit(ctx, mixed, 'supported');
    // The belief row was read (its revision is the stamp)…
    const lookup = h.calls.find((c) => /FROM semantic_belief/.test(c.sql));
    expect(lookup).toBeDefined();
    expect(JSON.stringify(lookup!.params)).toContain('semantic_belief:old');
    // …and the stored row carries it — this is what 0091 dropped.
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    expect(upsert.sql).toContain('dependencies: $dependencies');
    expect(upsert.params.dependencies).toEqual([
      { kind: 'belief', id: 'semantic_belief:old', rev: '3' },
    ]);
    expect(upsert.params.citedFactIds).toEqual(['knowledge_fact:f']);
    expect(h.outcomes).toEqual(['stored']);
  });

  it('a fact-only answer stores an empty dependency list and issues no dependency query', async () => {
    const h = makeHarness({});
    await h.svc.admit(ctx, { ...mixed, evidenceCitations: [] }, 'supported');
    expect(h.calls.some((c) => /FROM semantic_belief/.test(c.sql))).toBe(false);
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    expect(upsert.params.dependencies).toEqual([]);
    expect(h.outcomes).toEqual(['stored']);
  });

  it.each([
    ['belief already superseded', liveBelief({ status: 'superseded' })],
    // 0120 asserts status INSIDE ['active','superseded'], so anything else
    // is out-of-contract and reads as gone, not as a retraction.
    ['belief in an out-of-contract status', liveBelief({ status: 'retracted' })],
    ['belief past validUntil', liveBelief({ validUntil: new Date(Date.now() - 1_000) })],
    ['belief bound to another user (answer partition = bob)', liveBelief({ userId: 'alice' })],
  ] as Array<[string, Record<string, unknown>]>)(
    'not admitted when a dependency is already dead at admission: %s',
    async (name, row) => {
      const h = makeHarness({ dependencyRows: { belief: [row] } });
      const scoped = name.includes('another user') ? { ...ctx, userId: 'bob' } : ctx;
      await h.svc.admit(scoped, mixed, 'supported');
      expect(h.calls.some((c) => /UPSERT/.test(c.sql))).toBe(false);
      expect(h.outcomes).toEqual(['not_admitted']);
    },
  );

  it('not admitted when a dependency row is missing', async () => {
    const h = makeHarness({ dependencyRows: { belief: [] } });
    await h.svc.admit(ctx, mixed, 'supported');
    expect(h.calls.some((c) => /UPSERT/.test(c.sql))).toBe(false);
    expect(h.outcomes).toEqual(['not_admitted']);
  });

  it('not admitted when a citation carries no trackable arm (no query at all)', async () => {
    const h = makeHarness({ dependencyRows: { belief: [liveBelief()] } });
    await h.svc.admit(
      ctx,
      { ...mixed, evidenceCitations: [{ beliefId: 'semantic_belief:old' }, {}] },
      'supported',
    );
    expect(h.calls).toHaveLength(0);
    expect(h.outcomes).toEqual(['not_admitted']);
  });

  it('stamps every arm with its own revision: episode (existence), fragment (asset quarantine), scene (content hash)', async () => {
    const h = makeHarness({
      sceneWorld: WORLD,
      dependencyRows: {
        episode: [{ id: 'episode:ep1', userId: null }],
        fragment: [liveFragment()],
        scene: [liveScene({ id: 'memory_episode:sc1' })],
      },
    });
    await h.svc.admit(
      ctx,
      {
        ...mixed,
        evidenceCitations: [
          { episodeId: 'episode:ep1', conversationId: 'c1' },
          { fragmentId: 'evidence_fragment:fr1', assetId: 'evidence_asset:a1' },
          { sceneId: 'memory_episode:sc1' },
        ],
      },
      'supported',
    );
    const upsert = h.calls.find((c) => /UPSERT/.test(c.sql))!;
    const deps = upsert.params.dependencies as Array<{ kind: string; id: string; rev: string }>;
    expect(deps.map((d) => [d.kind, d.id])).toEqual([
      ['episode', 'episode:ep1'],
      ['fragment', 'evidence_fragment:fr1'],
      ['scene', 'memory_episode:sc1'],
    ]);
    expect(deps[0]!.rev).toBe('');
    expect(deps[1]!.rev).toBe('clean');
    expect(deps[2]!.rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a fragment whose asset is quarantine-rejected is dead at admission', async () => {
    const h = makeHarness({
      dependencyRows: { fragment: [liveFragment({ quarantineStatus: 'rejected' })] },
    });
    await h.svc.admit(
      ctx,
      { ...mixed, evidenceCitations: [{ fragmentId: 'evidence_fragment:fr1' }] },
      'supported',
    );
    expect(h.calls.some((c) => /UPSERT/.test(c.sql))).toBe(false);
    expect(h.outcomes).toEqual(['not_admitted']);
  });
});

describe('AnswerCacheService.begin — dependency check-on-read (0136)', () => {
  const beliefDep = { kind: 'belief', id: 'semantic_belief:b1', rev: '3' };
  const liveBelief = (over: Record<string, unknown> = {}) => ({
    id: 'semantic_belief:b1',
    revision: 3,
    status: 'active',
    supersededBy: null,
    validUntil: null,
    userId: null,
    ...over,
  });
  const args = () => beginArgs();
  /** Scene/belief arms only exist on a user-scoped answer (both lanes are
   *  scoped-user-only), so those cases ask as the pinned user. */
  const scopedArgs = () => beginArgs({ userId: 'alice' });

  it('the audit scenario: the cited fact still validates, the belief was superseded → cause=superseded, miss', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [beliefDep] }),
      factRows: [activeFact()],
      dependencyRows: {
        belief: [liveBelief({ status: 'superseded', supersededBy: 'semantic_belief:b2' })],
      },
    });
    const out = await h.svc.begin(args());
    expect(out?.hit).toBeUndefined();
    expect(h.outcomes).toEqual(['rejected_stale']);
    const inv = h.calls.find((c) => /invalidationCause/.test(c.sql))!;
    expect(inv.params.cause).toBe('superseded');
  });

  it.each([
    [
      'belief past validUntil → expired_validity',
      liveBelief({ validUntil: new Date(Date.now() - 1_000) }),
      'expired_validity',
    ],
    [
      'belief revised in place (revision moved) → dependency_changed',
      liveBelief({ revision: 4 }),
      'dependency_changed',
    ],
    [
      'belief left the servable lifecycle → missing',
      liveBelief({ status: 'competing' }),
      'missing',
    ],
    // 0120 asserts status INSIDE ['active','superseded']: 'retracted' is
    // not a state a belief can reach, so it reads as gone like any other
    // out-of-contract status — the 'retracted' cause belongs to FACTS.
    [
      'belief in an out-of-contract status → missing',
      liveBelief({ status: 'retracted' }),
      'missing',
    ],
    [
      'belief bound to another user → missing (existence never leaks)',
      liveBelief({ userId: 'bob' }),
      'missing',
    ],
  ] as Array<[string, Record<string, unknown>, string]>)('%s', async (_n, row, cause) => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [beliefDep] }),
      factRows: [activeFact()],
      dependencyRows: { belief: [row] },
    });
    expect((await h.svc.begin(args()))?.hit).toBeUndefined();
    expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(cause);
  });

  it('a dependency row that is gone → missing (existence never leaks)', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [beliefDep] }),
      factRows: [activeFact()],
      dependencyRows: { belief: [] },
    });
    expect((await h.svc.begin(args()))?.hit).toBeUndefined();
    expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('missing');
  });

  it('scene gist recomposed → dependency_changed; unchanged gist → serves', async () => {
    const admitted = makeHarness({
      sceneWorld: WORLD,
      dependencyRows: { scene: [liveScene()] },
    });
    await admitted.svc.admit(
      {
        key: 'c'.repeat(64),
        companyId: 'co_test',
        userId: 'alice',
        callerScopes: ['brain:read'],
        profileHash: 'ph',
        model: 'm',
        normalizedQuery: 'q',
        isEnumeration: false,
      },
      {
        answer: 'a',
        citations: [
          {
            factId: 'knowledge_fact:f1',
            entityId: 'knowledge_entity:e1',
            canonicalName: 'E',
            predicate: 'p',
            object: 'o',
          },
        ],
        evidenceCitations: [{ sceneId: 'memory_episode:s1' }],
        results: [],
      },
      'supported',
    );
    const stored = admitted.calls.find((c) => /UPSERT/.test(c.sql))!.params.dependencies as Array<
      Record<string, unknown>
    >;

    const changed = makeHarness({
      sceneWorld: WORLD,
      cacheRow: liveCacheRow({ dependencies: stored }),
      factRows: [activeFact()],
      dependencyRows: { scene: [liveScene({ gist: 'moved to B' })] },
    });
    expect((await changed.svc.begin(scopedArgs()))?.hit).toBeUndefined();
    expect(changed.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(
      'dependency_changed',
    );

    // Round-2 audit F4: `unexpectedDetails` is rendered into the scene
    // line, so re-detailing it must move the stamp too — the stamp used to
    // cover only gist + enrichedGist while the enricher rewrites both.
    const redetailed = makeHarness({
      sceneWorld: WORLD,
      cacheRow: liveCacheRow({ dependencies: stored }),
      factRows: [activeFact()],
      dependencyRows: { scene: [liveScene({ unexpectedDetails: ['the meeting is Tuesday'] })] },
    });
    expect((await redetailed.svc.begin(scopedArgs()))?.hit).toBeUndefined();
    expect(redetailed.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(
      'dependency_changed',
    );

    const same = makeHarness({
      sceneWorld: WORLD,
      cacheRow: liveCacheRow({ dependencies: stored }),
      factRows: [activeFact()],
      dependencyRows: { scene: [liveScene()] },
    });
    expect((await same.svc.begin(scopedArgs()))?.hit?.cached).toBe(true);

    // Round-2 audit F6/P3: the scene WORLD moved. Promotion demotes the
    // previous version to 'residual' without touching a single row, so
    // every stamp still matches — only the lane's world clause closes it.
    const promoted = makeHarness({
      sceneWorld: 'scene-segmenter-v2',
      cacheRow: liveCacheRow({ dependencies: stored }),
      factRows: [activeFact()],
      dependencyRows: { scene: [liveScene()] },
    });
    expect((await promoted.svc.begin(scopedArgs()))?.hit).toBeUndefined();
    expect(promoted.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(
      'missing',
    );
  });

  it('fragment: asset quarantine state moved → dependency_changed; rejected → missing', async () => {
    const dep = { kind: 'fragment', id: 'evidence_fragment:fr1', rev: 'clean' };
    const moved = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [dep] }),
      factRows: [activeFact()],
      dependencyRows: { fragment: [liveFragment({ quarantineStatus: 'pending' })] },
    });
    expect((await moved.svc.begin(args()))?.hit).toBeUndefined();
    expect(moved.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(
      'dependency_changed',
    );
    const rejected = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [dep] }),
      factRows: [activeFact()],
      dependencyRows: { fragment: [liveFragment({ quarantineStatus: 'rejected' })] },
    });
    expect((await rejected.svc.begin(args()))?.hit).toBeUndefined();
    expect(rejected.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(
      'missing',
    );
  });

  it('episode: the row exists → serves; forgotten → missing', async () => {
    const dep = { kind: 'episode', id: 'episode:ep1', rev: '' };
    const alive = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [dep] }),
      factRows: [activeFact()],
      dependencyRows: { episode: [{ id: 'episode:ep1', userId: null }] },
    });
    expect((await alive.svc.begin(args()))?.hit?.cached).toBe(true);
    const gone = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [dep] }),
      factRows: [activeFact()],
      dependencyRows: { episode: [] },
    });
    expect((await gone.svc.begin(args()))?.hit).toBeUndefined();
    expect(gone.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('missing');
  });

  it('every dependency live → serves, and the additive-write probe still runs after them', async () => {
    const served = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [beliefDep] }),
      factRows: [activeFact()],
      dependencyRows: { belief: [liveBelief()] },
    });
    const hit = await served.svc.begin(args());
    expect(hit?.hit?.cached).toBe(true);
    // The revalidated arm comes back as an id-only evidence citation.
    expect(hit?.hit?.evidenceCitations).toEqual([{ beliefId: 'semantic_belief:b1' }]);
    expect(served.outcomes).toEqual(['hit']);

    const newer = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [beliefDep] }),
      factRows: [activeFact()],
      dependencyRows: { belief: [liveBelief()] },
      probeRows: [newerFact()],
    });
    expect((await newer.svc.begin(args()))?.hit).toBeUndefined();
    expect(newer.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe(
      'newer_fact',
    );
  });

  it('precedence: a dead cited fact wins over a dead dependency', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [beliefDep] }),
      factRows: [activeFact({ status: 'retracted' })],
      dependencyRows: { belief: [liveBelief({ status: 'superseded' })] },
    });
    expect((await h.svc.begin(args()))?.hit).toBeUndefined();
    expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('retracted');
  });

  it('a pre-0136 row (no dependency list) is never served — fail closed before any fact read', async () => {
    const legacy = liveCacheRow();
    delete (legacy as Record<string, unknown>).dependencies;
    const h = makeHarness({ cacheRow: legacy, factRows: [activeFact()] });
    expect((await h.svc.begin(args()))?.hit).toBeUndefined();
    expect(h.calls.some((c) => /FROM knowledge_fact/.test(c.sql))).toBe(false);
    expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('missing');
    expect(h.outcomes).toEqual(['rejected_stale']);
  });

  it('a malformed stored dependency entry fails closed as missing', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ dependencies: [{ kind: 'belief', id: 'nope', rev: '1' }] }),
      factRows: [activeFact()],
      dependencyRows: { belief: [liveBelief()] },
    });
    expect((await h.svc.begin(args()))?.hit).toBeUndefined();
    expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('missing');
  });
});

/**
 * Round-2 audit F1 — the media-evidence leak, closed. The audit's
 * reproduction asserted the UNSAFE behaviour (equal keys across scope
 * sets, and a `brain:read` key served a face-classified fragment's text
 * out of an entry a `brain:read_media` key had admitted); every
 * assertion here is that same scenario, inverted.
 */
describe('AnswerCacheService — media evidence is re-fenced on every hit (round-2 F1)', () => {
  const ANSWER = 'Acme is gold tier. Sensitive information from a face-classified fragment.';
  const dep = { kind: 'fragment', id: 'evidence_fragment:private', rev: 'accepted' };
  const low = () => beginArgs();
  const high = () => ({ ...beginArgs(), callerScopes: ['brain:read', 'brain:read_media'] });
  /** The closed row the audit used: classified `face`, quarantine accepted. */
  const closedFragment = (over: Record<string, unknown> = {}) =>
    liveFragment({
      id: 'evidence_fragment:private',
      quarantineStatus: 'accepted',
      piiClasses: ['face'],
      ...over,
    });

  it('(b) the two scope sets no longer share a key', async () => {
    const h = makeHarness({ cacheRow: null });
    const lowKey = (await h.svc.begin(low()))?.ctx?.key;
    const highKey = (await h.svc.begin(high()))?.ctx?.key;
    expect(lowKey).toMatch(/^[0-9a-f]{64}$/);
    expect(highKey).not.toBe(lowKey);
    // The canonical per-item gate still refuses the row for the low key.
    expect(mediaPiiAllowed(['face'], low().callerScopes)).toBe(false);
  });

  it('(a) even ON the same key, a caller without brain:read_media MISSES', async () => {
    // The load-bearing half: pretend the key matched anyway (a stored row
    // handed straight to the low-scope caller). The fragment fence runs on
    // the hit path, so the closed text is never returned.
    const h = makeHarness({
      cacheRow: liveCacheRow({ answer: ANSWER, dependencies: [dep] }),
      factRows: [activeFact()],
      dependencyRows: { fragment: [closedFragment()] },
    });
    const out = await h.svc.begin(low());
    expect(out?.hit).toBeUndefined();
    expect(out?.ctx).toBeDefined();
    expect(h.outcomes).toEqual(['rejected_stale']);
    expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('missing');
  });

  it('the media-scoped caller is still served the same entry', async () => {
    const h = makeHarness({
      cacheRow: liveCacheRow({ answer: ANSWER, dependencies: [dep] }),
      factRows: [activeFact()],
      entityRows: [{ id: 'knowledge_entity:e1', canonicalName: 'Acme' }],
      dependencyRows: { fragment: [closedFragment()] },
    });
    expect((await h.svc.begin(high()))?.hit?.answer).toBe(ANSWER);
    expect(h.outcomes).toEqual(['hit']);
  });

  it.each([
    ['modality consent revoked after admission', high, {}, { mediaConsent: false }],
    // A later classifier pass finds a voice in a fragment a plain
    // brain:read answer was built from. The KEY is unchanged — only the
    // re-applied fence closes the entry.
    ['the fragment reclassified after admission', low, { piiClasses: ['voice'] }, {}],
    ['the asset erased (availability gone)', high, { assetAvailability: 'gone' }, {}],
    ['the asset bound to another user', high, { assetUserId: 'bob' }, {}],
  ] as Array<
    [
      string,
      () => ReturnType<typeof beginArgs>,
      Record<string, unknown>,
      { mediaConsent?: boolean },
    ]
  >)(
    'a rights change AFTER admission closes the entry for the SAME key: %s',
    async (_n, asks, rowOver, harnessOver) => {
      // What the scope hash alone cannot do — the key is unchanged here.
      const h = makeHarness({
        ...harnessOver,
        cacheRow: liveCacheRow({ answer: ANSWER, dependencies: [dep] }),
        factRows: [activeFact()],
        dependencyRows: { fragment: [closedFragment(rowOver)] },
      });
      expect((await h.svc.begin(asks()))?.hit).toBeUndefined();
      expect(h.calls.find((c) => /invalidationCause/.test(c.sql))!.params.cause).toBe('missing');
    },
  );
});

/**
 * Round-2 audit F4 — the retrieval snapshot. The audit's reproduction
 * asserted that an answer generated from Monday's scene was admitted
 * against Tuesday's hash and then served; admission now compares the
 * live stamp with the one the LANES observed and refuses to cache.
 */
describe('AnswerCacheService.admit — a dependency that moved during generation is not cached', () => {
  const ctx = (): AnswerCacheStoreContext => ({
    key: 'd'.repeat(64),
    companyId: 'co_test',
    userId: 'alice',
    callerScopes: ['brain:read'],
    profileHash: 'ph',
    model: 'm',
    normalizedQuery: 'when is the meeting',
    isEnumeration: false,
  });
  const result = (): SynthesizeResult => ({
    answer: 'Acme is gold tier. The meeting is Monday.',
    citations: [
      {
        factId: 'knowledge_fact:f1',
        entityId: 'knowledge_entity:e1',
        canonicalName: 'Acme',
        predicate: 'tier',
        object: 'gold',
      },
    ],
    evidenceCitations: [{ sceneId: 'memory_episode:s1' }],
    results: [],
  });

  it('refuses admission when the enricher rewrote the scene while the LLM ran', async () => {
    // What retrieval rendered (Monday) vs what the row says at admission
    // (Tuesday) — the enricher rewrites enrichedGist + unexpectedDetails.
    const monday = liveScene({
      enrichedGist: 'Meeting Monday.',
      unexpectedDetails: ['The meeting is Monday.'],
    });
    const tuesday = liveScene({
      enrichedGist: 'Meeting Tuesday.',
      unexpectedDetails: ['The meeting is Tuesday.'],
    });
    const h = makeHarness({ sceneWorld: WORLD, dependencyRows: { scene: [tuesday] } });
    const c = ctx();
    h.svc.observeRendered(c, {
      scene: new Map([['memory_episode:s1', { stamp: sceneStamp(monday) }]]),
    });
    await h.svc.admit(c, result(), 'supported');
    expect(h.calls.some((call) => /UPSERT/.test(call.sql))).toBe(false);
    expect(h.outcomes).toEqual(['not_admitted']);
  });

  it('admits — with the observed stamp — when the scene did not move', async () => {
    const scene = liveScene({ enrichedGist: 'Meeting Monday.' });
    const h = makeHarness({ sceneWorld: WORLD, dependencyRows: { scene: [scene] } });
    const c = ctx();
    h.svc.observeRendered(c, {
      scene: new Map([['memory_episode:s1', { stamp: sceneStamp(scene) }]]),
    });
    await h.svc.admit(c, result(), 'supported');
    const upsert = h.calls.find((call) => /UPSERT/.test(call.sql))!;
    expect(upsert.params.dependencies).toEqual([
      { kind: 'scene', id: 'memory_episode:s1', rev: sceneStamp(scene) },
    ]);
    expect(h.outcomes).toEqual(['stored']);
  });

  it('refuses admission when the lanes never rendered the cited dependency', async () => {
    // An observation was made, and this arm is not in it: the cache cannot
    // say what the generator saw, so it must not store the answer.
    const h = makeHarness({ sceneWorld: WORLD, dependencyRows: { scene: [liveScene()] } });
    const c = ctx();
    h.svc.observeRendered(c, { scene: new Map() });
    await h.svc.admit(c, result(), 'supported');
    expect(h.calls.some((call) => /UPSERT/.test(call.sql))).toBe(false);
    expect(h.outcomes).toEqual(['not_admitted']);
  });
});
