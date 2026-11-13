/**
 * Every write of an embedding vector also writes `embeddingSpaceId`
 * (migration 0101), unconditionally — one helper (`spaceStamp`), stamped at
 * the write site. Without it the first embedder switch mixes vector spaces
 * with no record of which row is which, and the re-embed can only be
 * all-or-nothing per tenant.
 *
 * Pins one writer of each kind over scripted doubles (no DB, no model):
 *   - the helper itself;
 *   - facts: fn::settle_fact has no space parameter, so the resolver stamps
 *     the returned ids right after the call — per-fact, batched and the
 *     derived-world batch; nothing to stamp when no row was created; a
 *     failed stamp never fails the ingest;
 *   - CREATE-with-CONTENT writers: strategy memory, procedural memory;
 *   - predicate rows: the seed helper and the registry's create().
 * The composers (segment, arc / aggregate kernel), the community builder
 * and the promotion runner are pinned in their own suites.
 */
import { FactResolverService } from '../src/ingest/fact-resolver.service';
import { spaceStamp, EMBEDDING_SPACE_FIELD } from '../src/ai/embedder/embedding-space';
import { StrategyMemoryService } from '../src/strategy/strategy-memory.service';
import { ProceduralMemoryService } from '../src/procedural/procedural-memory.service';
import { seedMissingPredicates } from '../src/ai/predicate-registry-internals/seed-predicates';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import type { ConfigService } from '@nestjs/config';
import type { PredicateDefinition } from '../src/ai/predicate-registry-internals/types';

const SPACE = 'bge-m3:Xenova/bge-m3:1024:l2';

interface Call {
  sql: string;
  params: Record<string, any> | undefined;
}

beforeEach(() => {
  for (const k of [
    'CONFLICT_DIRECT_FACT_SLOT',
    'CONFLICT_MENTION_FACT_SLOT',
    'CONFLICT_SLOT_CANONICALIZATION',
  ])
    process.env[k] ??= '0';
});

describe('spaceStamp', () => {
  it('names the active space under the one column name', () => {
    expect(spaceStamp({ activeSpaceId: () => SPACE })).toEqual({ [EMBEDDING_SPACE_FIELD]: SPACE });
    expect(EMBEDDING_SPACE_FIELD).toBe('embeddingSpaceId');
  });
});

// ── facts ───────────────────────────────────────────────────────────────

function makeResolver(opts: { outcome?: string; failStamp?: boolean } = {}) {
  const outcome = opts.outcome ?? 'INSERTED';
  const calls: Call[] = [];
  const db = {
    query: jest.fn(async (sql: string, params: any) => {
      calls.push({ sql, params });
      if (sql.includes('embeddingSpaceId') && opts.failStamp) throw new Error('boom');
      const id = (tail: string) => (outcome === 'REJECTED' ? null : `knowledge_fact:${tail}`);
      if (sql.includes('fn::settle_facts')) {
        return [
          params.facts.map((f: any, i: number) => ({ factId: id(`b${i}_${f.object}`), outcome })),
        ];
      }
      if (sql.includes('fn::settle_fact(')) return [{ factId: id(`s_${params.object}`), outcome }];
      return [[]];
    }),
  };
  const factEmbedding = {
    embed: jest.fn(async () => [0.1, 0.2]),
    activeSpaceId: () => SPACE,
    writeAltEmbeddingIfHype: jest.fn(async () => {}),
  };
  const predicateRegistry = {
    getSnapshot: jest.fn(async () => ({})),
    policyFor: jest.fn((_c: string, p: string) => ({
      semantics: p === 'status' ? 'single_active' : 'append_only',
    })),
  };
  const svc = new FactResolverService(factEmbedding as never, predicateRegistry as never);
  return { svc, db, calls };
}

function factInput(predicate: string, object: string) {
  return {
    companyId: 'co_x',
    entityId: 'knowledge_entity:e1',
    predicate,
    object,
    confidence: 0.9,
    validFrom: new Date('2023-01-01T00:00:00Z'),
    source: {},
    precomputedEmbedding: [0.1, 0.2],
  };
}

const stamps = (calls: Call[]) => calls.filter((c) => c.sql.includes('embeddingSpaceId'));
const idsOf = (c: Call) => (c.params?.ids as Array<{ toString(): string }>).map(String);

describe('facts — stamped right after fn::settle_fact, keyed by the returned id', () => {
  it('per-fact path (single_active): the created row gets the active space', async () => {
    const { svc, db, calls } = makeResolver();
    await svc.resolve(db as never, factInput('status', 'active'));
    const settle = calls.findIndex((c) => c.sql.includes('fn::settle_fact('));
    const [stamp] = stamps(calls);
    expect(stamp!.sql).toBe('UPDATE knowledge_fact SET embeddingSpaceId = $space WHERE id IN $ids');
    expect(stamp!.params?.space).toBe(SPACE);
    expect(idsOf(stamp!)).toEqual(['knowledge_fact:s_active']);
    // Never passed to the stored function — its signature is untouched.
    expect(calls[settle]!.params).not.toHaveProperty('embeddingSpaceId');
    expect(calls.indexOf(stamp!)).toBeGreaterThan(settle);
  });

  it('batched append_only path: one stamp covering every created row', async () => {
    const { svc, db, calls } = makeResolver();
    await svc.resolveMany(db as never, [factInput('likes', 'a'), factInput('likes', 'b')]);
    const batch = calls.find((c) => c.sql.includes('fn::settle_facts'))!;
    for (const f of batch.params!.facts) expect(f).not.toHaveProperty('embeddingSpaceId');
    const all = stamps(calls);
    expect(all).toHaveLength(1);
    expect(all[0]!.params?.space).toBe(SPACE);
    expect(idsOf(all[0]!)).toEqual(['knowledge_fact:b0_a', 'knowledge_fact:b1_b']);
  });

  it('derived-world batch: an explicit space wins, an absent one is the active space', async () => {
    const { svc, db, calls } = makeResolver();
    const row = {
      entityId: 'knowledge_entity:e1',
      predicate: 'other',
      confidence: 0.85,
      embedding: [0.1, 0.2],
      validFrom: new Date('2023-01-01T00:00:00Z'),
      source: {},
      sourceTrust: 0.5,
      derivedVersion: 'v1.staging',
    };
    await svc.resolveDerivedBatch(db as never, [
      { ...row, object: 'x' },
      { ...row, object: 'y', embeddingSpaceId: 'openai:text-embedding-3-small:1536:l2' },
    ]);
    const bySpace = new Map(stamps(calls).map((c) => [c.params?.space, idsOf(c)]));
    expect(bySpace.get(SPACE)).toEqual(['knowledge_fact:b0_x']);
    expect(bySpace.get('openai:text-embedding-3-small:1536:l2')).toEqual(['knowledge_fact:b1_y']);
  });

  it('no row created (REJECTED) ⇒ nothing to stamp', async () => {
    const { svc, db, calls } = makeResolver({ outcome: 'REJECTED' });
    await svc.resolve(db as never, factInput('status', 'active'));
    await svc.resolveMany(db as never, [factInput('likes', 'a')]);
    expect(stamps(calls)).toHaveLength(0);
  });

  it('a failed stamp never fails the ingest (the row reads as legacy space)', async () => {
    const { svc, db } = makeResolver({ failStamp: true });
    const { result } = await svc.resolve(db as never, factInput('status', 'active'));
    expect(result.outcome).toBe('INSERTED');
  });
});

// ── CREATE-with-CONTENT writers ────────────────────────────────────────

function recordingSurreal(row: Record<string, unknown>) {
  const calls: Call[] = [];
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => unknown) =>
      fn({
        query: async (sql: string, params?: Record<string, any>) => {
          calls.push({ sql, params });
          return [row];
        },
      }),
  } as unknown as SurrealService;
  return { surreal, calls };
}

const embedder = {
  embed: async () => [1, 0],
  embedForWrite: async () => [1, 0],
  embedManyForWrite: async (t: string[]) => t.map(() => [1, 0]),
  activeSpaceId: () => SPACE,
} as unknown as EmbedderService;

describe('CREATE-with-CONTENT writers carry the space beside the vector', () => {
  it('strategy memory', async () => {
    const { surreal, calls } = recordingSurreal({
      id: 'strategy_memory:a1',
      title: 'T',
      situation: 'S',
      strategy: 'do it',
      polarity: 'do',
      status: 'candidate',
      evidence: {},
      scope: 'tenant',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const config = { get: (_k: string, d?: string) => d } as unknown as ConfigService;
    await new StrategyMemoryService(surreal, embedder, config).create('c1', {
      title: 'T',
      situation: 'S',
      strategy: 'do it',
      polarity: 'do',
    });
    const create = calls.find((c) => c.sql.includes('CREATE ONLY strategy_memory'))!;
    expect(create.sql).toContain('embedding: $embedding,');
    expect(create.sql).toContain('embeddingSpaceId: $embeddingSpaceId,');
    expect(create.params).toMatchObject({ embedding: [1, 0], embeddingSpaceId: SPACE });
  });

  it('procedural memory', async () => {
    const { surreal, calls } = recordingSurreal({
      id: 'procedural_memory:p1',
      trigger: 'when X',
      action: 'do Y',
      priority: 100,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await new ProceduralMemoryService(surreal, embedder).record('c1', {
      trigger: 'when X',
      action: 'do Y',
    });
    const create = calls.find((c) => c.sql.includes('CREATE ONLY procedural_memory'))!;
    expect(create.sql).toContain('triggerEmbedding: $embedding,');
    expect(create.sql).toContain('embeddingSpaceId: $embeddingSpaceId,');
    expect(create.params).toMatchObject({ embedding: [1, 0], embeddingSpaceId: SPACE });
  });
});

// ── predicate rows ─────────────────────────────────────────────────────

describe('predicate rows', () => {
  it('seeded predicates carry the space with their card vector', async () => {
    const calls: Call[] = [];
    const db = {
      query: async (sql: string, params?: Record<string, any>) => {
        calls.push({ sql, params });
        return [[]];
      },
    };
    const def = {
      predicateId: 'works_at',
      displayLabel: 'works at',
      description: 'employer',
      datatype: 'string',
      semantics: 'single_active',
      decayHalfLifeDays: null,
      piiClass: 'none',
      status: 'active',
      createdBy: 'system',
    } as unknown as PredicateDefinition;
    await seedMissingPredicates({ db: db as never, predicates: [def], embedder });
    const create = calls.find((c) => c.sql.includes('CREATE knowledge_predicate'))!;
    expect(create.params?.content).toMatchObject({ embedding: [1, 0], embeddingSpaceId: SPACE });
  });

  it('a predicate written without a vector carries no space either', async () => {
    const calls: Call[] = [];
    const db = {
      query: async (sql: string, params?: Record<string, any>) => {
        calls.push({ sql, params });
        return [[]];
      },
    };
    const failing = {
      embedManyForWrite: async () => {
        throw new Error('primary warming');
      },
      activeSpaceId: () => SPACE,
    } as unknown as EmbedderService;
    const def = { predicateId: 'likes', displayLabel: 'likes' } as unknown as PredicateDefinition;
    await seedMissingPredicates({ db: db as never, predicates: [def], embedder: failing });
    const create = calls.find((c) => c.sql.includes('CREATE knowledge_predicate'))!;
    expect(create.params?.content).not.toHaveProperty('embedding');
    expect(create.params?.content).not.toHaveProperty('embeddingSpaceId');
  });
});
