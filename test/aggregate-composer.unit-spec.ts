import { ConfigService } from '@nestjs/config';
import {
  AggregateComposerService,
  AGGREGATE_RECORDER,
} from '../src/admin/aggregate-composer.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';

function makeSvc(opts: {
  tops: Array<{ entityId: string; n: number }>;
  facts: Array<{ id: string; predicate: string; object: string; validFrom: string }>;
  llm: unknown;
}): {
  svc: AggregateComposerService;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes('GROUP BY entityId')) return [opts.tops];
      if (sql.includes('canonicalName FROM')) return [[{ canonicalName: 'Melanie' }]];
      if (sql.includes('SELECT id, predicate')) return [opts.facts];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_co: string, fn: (d: unknown) => Promise<unknown>) =>
      fn(db),
  } as unknown as SurrealService;
  const config = {
    get: (key: string, dflt?: string) =>
      key === 'OPENAI_API_KEY' ? 'sk-test' : dflt,
    getOrThrow: (key: string) => {
      if (key === 'OPENAI_API_KEY') return 'sk-test';
      throw new Error(`missing ${key}`);
    },
  } as unknown as ConfigService;
  const embedding = {
    embedMany: async (texts: string[]) => texts.map(() => [1, 0]),
  } as unknown as FactEmbeddingService;
  const svc = new AggregateComposerService(surreal, config, embedding);
  (svc as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            { message: { content: JSON.stringify(opts.llm) } },
          ],
        }),
      },
    },
  };
  return { svc, queries };
}

const FACTS = [
  { id: 'knowledge_fact:f0', predicate: 'has_pet', object: 'cat Bailey', validFrom: '2023-01-01' },
  { id: 'knowledge_fact:f1', predicate: 'adopted', object: 'a dog', validFrom: '2023-06-01' },
  { id: 'knowledge_fact:f2', predicate: 'hobby', object: 'pottery', validFrom: '2023-02-01' },
  { id: 'knowledge_fact:f3', predicate: 'went_on', object: 'a hike', validFrom: '2023-03-01' },
  { id: 'knowledge_fact:f4', predicate: 'loves', object: 'camping', validFrom: '2023-04-01' },
];

describe('AggregateComposerService (Lane C v1)', () => {
  it('writes aggregates with slugged predicate, provenance, and embedding', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: {
        aggregates: [
          { aspect: 'Pets!', proposition: "Melanie's pets: cat Bailey and a dog.", members: [0, 1] },
          { aspect: 'activities', proposition: "Melanie's activities: pottery, hiking, camping.", members: [2, 3, 4] },
        ],
      },
    });
    const res = await svc.run('co_x');
    expect(res).toMatchObject({ entities: 1, aggregatesWritten: 2, skipped: [] });
    const deletes = queries.filter((q) => q.sql.includes('DELETE knowledge_fact'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0].params?.recorder).toBe(AGGREGATE_RECORDER);
    // Atomic swap (audit W2): delete + insert share ONE transaction —
    // a reader never sees the entity stripped of its aggregates.
    expect(deletes[0].sql).toContain('BEGIN TRANSACTION');
    expect(deletes[0].sql).toContain('INSERT INTO knowledge_fact');
    const rows = deletes[0].params?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].predicate).toBe('aggregate_pets_');
    expect(rows[1].predicate).toBe('aggregate_activities');
    expect((rows[0].derivedFrom as unknown[]).length).toBe(2);
    expect(rows[0].embedding).toEqual([1, 0]);
  });

  it('filters aggregates with <2 members or out-of-range indexes', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: {
        aggregates: [
          { aspect: 'solo', proposition: 'one member only', members: [0] },
          { aspect: 'broken', proposition: 'bad index', members: [0, 99] },
        ],
      },
    });
    const res = await svc.run('co_x');
    expect(res.aggregatesWritten).toBe(0);
    expect(
      queries.some((q) => q.sql.includes('INSERT INTO knowledge_fact')),
    ).toBe(false);
  });

  it('skips entities with too few facts without calling the LLM', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:tiny', n: 2 }],
      facts: FACTS.slice(0, 2),
      llm: { aggregates: [] },
    });
    const res = await svc.run('co_x');
    expect(res).toMatchObject({ entities: 1, aggregatesWritten: 0 });
    expect(queries.some((q) => q.sql.includes('DELETE'))).toBe(false);
  });

  it('version mode scopes sources and stamps derivedVersion (R4)', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: {
        aggregates: [
          {
            aspect: 'activities',
            proposition: "Melanie's activities: pottery, hiking, camping.",
            members: [2, 3, 4],
          },
        ],
      },
    });
    const res = await svc.run('co_x', { version: 'wd-v2' });
    expect(res.aggregatesWritten).toBe(1);
    const tops = queries.find((q) => q.sql.includes('GROUP BY entityId'));
    expect(tops?.sql).toContain('derivedVersion = $version');
    expect(tops?.params?.version).toBe('wd-v2');
    const swap = queries.find((q) =>
      q.sql.includes('INSERT INTO knowledge_fact'),
    );
    const rows = swap?.params?.rows as Array<Record<string, unknown>>;
    expect(rows[0].derivedVersion).toBe('wd-v2');
    const del = queries.find((q) => q.sql.includes('DELETE knowledge_fact'));
    expect(del?.sql).toContain('derivedVersion = $version');
  });

  it('legacy mode pins the NONE namespace on all three queries', async () => {
    const { svc, queries } = makeSvc({
      tops: [],
      facts: [],
      llm: { aggregates: [] },
    });
    await svc.run('co_x');
    const tops = queries.find((q) => q.sql.includes('GROUP BY entityId'));
    expect(tops?.sql).toContain('derivedVersion IS NONE');
  });

  it('records per-entity failures without failing the run', async () => {
    const { svc } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: { aggregates: [] },
    });
    (svc as unknown as { openai: unknown }).openai = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('llm down');
          },
        },
      },
    };
    const res = await svc.run('co_x');
    expect(res.entities).toBe(0);
    expect(res.skipped).toEqual([
      { entityId: 'knowledge_entity:mel', reason: 'llm down' },
    ]);
  });
});
