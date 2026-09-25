/**
 * The relation leg brings the edges of the entities a query names, at
 * the asked time, as fact-shaped rows of their subject — so an entity
 * whose only knowledge at T is a relation still reaches the answer plane
 * ("brain — runs_on → gpt-5.6-luna (until 2026-09-24)" for a question
 * about the 20th, when every fact about brain was written on the 24th).
 */
import type { Surreal } from 'surrealdb';
import { runRelationLeg } from '../src/search/internals/relation-leg';

function db(results: unknown[][]): {
  db: Surreal;
  sql: string[];
  params: Array<Record<string, unknown>>;
} {
  const sql: string[] = [];
  const params: Array<Record<string, unknown>> = [];
  let i = 0;
  return {
    sql,
    params,
    db: {
      query: async (q: string, p?: Record<string, unknown>) => {
        sql.push(q);
        params.push(p ?? {});
        return results[i++] ?? [[]];
      },
    } as unknown as Surreal,
  };
}

const brain = {
  id: 'knowledge_entity:brain',
  type: 'project',
  canonicalName: 'brain',
  userId: null,
};
const luna56 = {
  id: 'knowledge_entity:l56',
  type: 'asset',
  canonicalName: 'gpt-5.6-luna',
  userId: null,
};

describe('runRelationLeg', () => {
  it('names entities by any word of the query and cuts their edges at asOf in valid time', async () => {
    const {
      db: d,
      sql,
      params,
    } = db([
      [[{ id: 'knowledge_entity:brain', score: 2.1 }]],
      [
        [
          {
            id: 'knowledge_edge:e1',
            kind: 'runs_on',
            validUntil: new Date('2026-09-24T00:00:00Z'),
            fromE: brain,
            toE: luna56,
          },
        ],
      ],
    ]);
    const rows = await runRelationLeg({
      db: d,
      queryText: 'На какой модели работал движок brain?',
      asOf: '2026-09-20T12:00:00Z',
      fetchK: 50,
    });
    expect(sql[0]).toContain('canonicalName @1@ $t0');
    expect(sql[0]).toContain(' OR ');
    expect(sql[1]).toContain('validUntil > $edgeAsOf');
    expect(sql[1]).toContain('WHERE in INSIDE $ids');
    expect(params[1]).toHaveProperty('edgeAsOf');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'knowledge_edge:e1',
      entityId: 'knowledge_entity:brain',
      predicate: 'runs_on',
      object: 'gpt-5.6-luna',
      validFrom: '',
      validUntil: '2026-09-24T00:00:00.000Z',
      bm25Score: 2.1,
    });
  });

  it('never returns an edge that ends on another user’s entity', async () => {
    const { db: d } = db([
      [[{ id: 'knowledge_entity:brain', score: 1 }]],
      [
        [
          {
            id: 'knowledge_edge:e2',
            kind: 'knows',
            fromE: brain,
            toE: { id: 'knowledge_entity:x', type: 'person', canonicalName: 'X', userId: 'bob' },
          },
        ],
      ],
    ]);
    const rows = await runRelationLeg({ db: d, queryText: 'brain', userId: 'alice', fetchK: 10 });
    expect(rows).toHaveLength(0);
  });

  it('no named entity, no edge query', async () => {
    const { db: d, sql } = db([[[]]]);
    expect(await runRelationLeg({ db: d, queryText: 'что нового?', fetchK: 10 })).toEqual([]);
    expect(sql).toHaveLength(1);
  });
});
