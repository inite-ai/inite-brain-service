import { ConfigService } from '@nestjs/config';
import {
  ArcComposerService,
  ARC_RECORDER,
  arcValidFrom,
  validArc,
} from '../src/admin/arc-composer.service';
import { AGGREGATE_RECORDER } from '../src/admin/aggregate-composer.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';

/**
 * V9 §3 — observations v2: topic arcs. The insight SLOT pays (+10pp
 * BEAM summarization) but aggregates are attribute rollups; the arcs
 * are dated chronological narratives per topic, written as
 * summary_arc_* facts so they ride the existing insight pool filter
 * (predicate prefix), budget slot, and dispatch with zero read-path
 * changes.
 */

function makeSvc(opts: {
  tops: Array<{ entityId: string; n: number }>;
  facts: Array<{
    id: string;
    predicate: string;
    object: string;
    validFrom: string;
  }>;
  llm: unknown;
}): {
  svc: ArcComposerService;
  queries: Array<{ sql: string; params?: Record<string, unknown> }>;
} {
  const queries: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes('GROUP BY entityId')) return [opts.tops];
      if (sql.includes('canonicalName FROM')) {
        return [[{ canonicalName: 'Melanie' }]];
      }
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
  const svc = new ArcComposerService(surreal, config, embedding);
  (svc as unknown as { openai: unknown }).openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(opts.llm) } }],
        }),
      },
    },
  };
  return { svc, queries };
}

const FACTS = [
  { id: 'knowledge_fact:f0', predicate: 'plans', object: 'started planning a move to Austin', validFrom: '2024-03-01' },
  { id: 'knowledge_fact:f1', predicate: 'plans', object: 'chose Austin over Denver', validFrom: '2024-05-10' },
  { id: 'knowledge_fact:f2', predicate: 'residence', object: 'signed a lease in Austin', validFrom: '2024-06-12' },
  { id: 'knowledge_fact:f3', predicate: 'activities', object: 'ran a first 10k', validFrom: '2024-04-01' },
  { id: 'knowledge_fact:f4', predicate: 'activities', object: 'finished a half-marathon', validFrom: '2024-06-20' },
];

describe('validArc / arcValidFrom (pure gates)', () => {
  it('needs ≥2 members spanning ≥2 distinct dates', () => {
    expect(
      validArc({ topic: 't', narrative: 'n', members: [0, 1] }, FACTS),
    ).toBe(true);
    expect(validArc({ topic: 't', narrative: 'n', members: [0] }, FACTS)).toBe(
      false,
    );
    expect(
      validArc({ topic: 't', narrative: 'n', members: [0, 99] }, FACTS),
    ).toBe(false);
    expect(
      validArc({ topic: 't', narrative: '  ', members: [0, 1] }, FACTS),
    ).toBe(false);
    // Same-day beats are an aggregate, not an arc.
    const sameDay = FACTS.map((f) => ({ ...f, validFrom: '2024-03-01' }));
    expect(
      validArc({ topic: 't', narrative: 'n', members: [0, 1] }, sameDay),
    ).toBe(false);
  });

  it('arc validFrom = latest member beat', () => {
    const d = arcValidFrom({ topic: 't', narrative: 'n', members: [0, 2] }, FACTS);
    expect(d.toISOString().slice(0, 10)).toBe('2024-06-12');
  });
});

describe('ArcComposerService (V9 §3)', () => {
  it('writes summary_arc_* rows with provenance, latest-beat validFrom, embedding', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: {
        arcs: [
          {
            topic: 'Apartment Move!',
            narrative:
              'Started planning the move in March 2024; chose Austin over Denver in May; signed the lease on June 12.',
            members: [0, 1, 2],
          },
          {
            topic: 'running',
            narrative: 'Ran a first 10k in April 2024; finished a half-marathon on June 20.',
            members: [3, 4],
          },
        ],
      },
    });
    const res = await svc.run('co_x');
    expect(res).toMatchObject({ entities: 1, arcsWritten: 2, skipped: [] });
    const swap = queries.find((q) => q.sql.includes('DELETE knowledge_fact'));
    expect(swap?.params?.recorder).toBe(ARC_RECORDER);
    expect(swap?.sql).toContain('BEGIN TRANSACTION');
    expect(swap?.sql).toContain('INSERT INTO knowledge_fact');
    const rows = swap?.params?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.predicate).toBe('summary_arc_apartment_move_');
    expect(rows[1]!.predicate).toBe('summary_arc_running');
    expect((rows[0]!.derivedFrom as unknown[]).length).toBe(3);
    expect(rows[0]!.embedding).toEqual([1, 0]);
    expect((rows[0]!.validFrom as Date).toISOString().slice(0, 10)).toBe(
      '2024-06-12',
    );
    expect(rows[0]!.source).toMatchObject({ recorder: ARC_RECORDER });
  });

  it('sources exclude both composers and the summary_ prefix', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: { arcs: [] },
    });
    await svc.run('co_x');
    const src = queries.find((q) => q.sql.includes('SELECT id, predicate'));
    expect(src?.sql).toContain("!string::starts_with(predicate, 'summary_')");
    expect(src?.params?.aggRecorder).toBe(AGGREGATE_RECORDER);
    expect(src?.params?.recorder).toBe(ARC_RECORDER);
  });

  it('filters single-date and out-of-range arcs; no swap when none valid', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: {
        arcs: [
          { topic: 'thin', narrative: 'one beat', members: [0] },
          { topic: 'broken', narrative: 'bad index', members: [0, 99] },
        ],
      },
    });
    const res = await svc.run('co_x');
    expect(res.arcsWritten).toBe(0);
    expect(
      queries.some((q) => q.sql.includes('INSERT INTO knowledge_fact')),
    ).toBe(false);
  });

  it('version mode scopes sources and stamps derivedVersion', async () => {
    const { svc, queries } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: {
        arcs: [
          {
            topic: 'move',
            narrative: 'Planned in March; signed in June.',
            members: [0, 2],
          },
        ],
      },
    });
    const res = await svc.run('co_x', { version: 'wd-v9' });
    expect(res.arcsWritten).toBe(1);
    const tops = queries.find((q) => q.sql.includes('GROUP BY entityId'));
    expect(tops?.sql).toContain('derivedVersion = $version');
    const swap = queries.find((q) =>
      q.sql.includes('INSERT INTO knowledge_fact'),
    );
    const rows = swap?.params?.rows as Array<Record<string, unknown>>;
    expect(rows[0]!.derivedVersion).toBe('wd-v9');
  });

  it('records per-entity failures without failing the run', async () => {
    const { svc } = makeSvc({
      tops: [{ entityId: 'knowledge_entity:mel', n: 5 }],
      facts: FACTS,
      llm: { arcs: [] },
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
