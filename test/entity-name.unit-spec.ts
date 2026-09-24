/**
 * An entity's name follows its `name` fact (src/ingest/entity-name.ts):
 *  - one UPDATE, gated on the predicate (canon `name`) and on the
 *    outcomes that make the fact current (INSERTED / SUPERSEDED);
 *  - the WHERE reads the row itself: an entity still named by its
 *    reference id, or the user's own entity (its key among the refs);
 *  - the old canonical name stays an alias; the new name gains its
 *    transliteration key.
 * And the asker's own entity is headed "you" on the evidence lines
 * (src/synthesize/fact-index.ts) — subject and relation peer alike.
 */
import type { Surreal } from 'surrealdb';
import { followNameFact } from '../src/ingest/entity-name';
import { buildFactIndex } from '../src/synthesize/fact-index';
import type { SearchHit } from '../src/search/search.service';

function db(updated: number) {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => {
        calls.push({ sql, params: params ?? {} });
        return [Array.from({ length: updated }, () => ({ id: 'knowledge_entity:x' }))];
      },
    } as unknown as Surreal,
  };
}

const base = {
  entityId: 'knowledge_entity:x',
  predicate: 'name',
  object: ' Sasha ',
  userId: 'u42',
  outcome: 'INSERTED',
};

describe('followNameFact', () => {
  it('renames on a current `name` fact: placeholder-or-user WHERE, old name kept as alias', async () => {
    const { db: d, calls } = db(1);
    expect(await followNameFact(d, base)).toBe(true);
    const [q] = calls;
    expect(q!.sql).toContain('canonicalName IN object::values(externalRefs ?? {})');
    expect(q!.sql).toContain('$userKey IN object::keys(externalRefs ?? {})');
    expect(q!.sql).toContain('array::union(aliases ?? [], [canonicalName, $name])');
    expect(q!.params).toMatchObject({ name: 'Sasha', userKey: 'user__u42::u::u42' });
    expect(q!.params['keys']).toEqual(expect.arrayContaining([expect.any(String)]));
    // The fact's scope must be the entity's: a personal name fact renames
    // only a personal node, a tenant-global one only a tenant-global node.
    expect(q!.sql).toContain(
      'IF $factUser IS NONE THEN userId IS NONE ELSE userId = $factUser END',
    );
    expect(q!.params).toMatchObject({ factUser: 'u42' });
  });

  it('a coined predicate aliased onto `name` counts; other predicates, non-current outcomes and empty names do not', async () => {
    const { db: d, calls } = db(1);
    expect(
      await followNameFact(d, { ...base, predicate: 'full_name', predicateAlias: 'name' }),
    ).toBe(true);
    expect(await followNameFact(d, { ...base, predicate: 'nickname' })).toBe(false);
    expect(await followNameFact(d, { ...base, outcome: 'COMPETING' })).toBe(false);
    expect(await followNameFact(d, { ...base, outcome: 'CORROBORATED' })).toBe(false);
    expect(await followNameFact(d, { ...base, outcome: undefined })).toBe(false);
    expect(await followNameFact(d, { ...base, object: '   ' })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('without a userId only the placeholder clause can match; a row the WHERE rejects reports false', async () => {
    const { db: d, calls } = db(0);
    expect(await followNameFact(d, { ...base, userId: undefined })).toBe(false);
    expect(calls[0]!.params['userKey']).toBe('');
    expect(calls[0]!.params['factUser']).toBeUndefined();
  });
});

const hit = (
  name: string,
  facts: Array<[string, string, string]>,
  relations: SearchHit['relations'] = [],
): SearchHit =>
  ({
    entityId: `knowledge_entity:${name}`,
    entityType: 'person',
    canonicalName: name,
    externalRefs: {},
    score: 1,
    relations,
    facts: facts.map(([id, predicate, object]) => ({
      factId: `knowledge_fact:${id}`,
      predicate,
      object,
      confidence: 0.9,
      score: 1,
    })),
  }) as unknown as SearchHit;

describe('the asker\'s entity is headed "you"', () => {
  it('on its own fact lines and on either side of a relation; other entities keep their names', () => {
    const res = buildFactIndex(
      [
        hit(
          'u42',
          [['a1', 'moved_to', 'Berlin']],
          [
            {
              kind: 'lives_at',
              peer: 'Berlin',
              peerType: 'location',
              peerId: 'knowledge_entity:Berlin',
              edgeId: 'knowledge_edge:e1',
              direction: 'out',
            },
          ],
        ),
        hit(
          'Pedro',
          [['b1', 'role', 'engineer']],
          [
            {
              kind: 'covers_for',
              peer: 'u42',
              peerType: 'person',
              peerId: 'knowledge_entity:u42',
              edgeId: 'knowledge_edge:e2',
              direction: 'out',
            },
          ],
        ),
      ],
      { askerEntityId: 'knowledge_entity:u42' },
    );
    expect(res.factLines).toEqual([
      '[f1] you — moved_to: Berlin',
      '[r1] you — lives_at → Berlin (location)',
      '[f2] Pedro (person) — role: engineer',
      '[r2] Pedro (person) — covers_for → you',
    ]);
    // Citations keep the entity's real name — the label is prompt-side only.
    expect(res.factIndex.get('knowledge_fact:a1')?.canonicalName).toBe('u42');
    // Without an asker the lines are as they always were.
    const plain = buildFactIndex([hit('u42', [['a1', 'moved_to', 'Berlin']])]);
    expect(plain.factLines).toEqual(['[f1] u42 (person) — moved_to: Berlin']);
  });
});
