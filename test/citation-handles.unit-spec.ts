/**
 * Short citation handles (fact-index.ts factHandle, synthesize.helpers
 * expandCitationHandles). Found on prod 2026-09-17: on a twelve-line
 * evidence set gpt-4o-mini mis-cited two of three CORRECT answers — one
 * `[knowledge_fact:…]` copied from the wrong line, one invented from a
 * `[source 2026-09-17 …]` quote tag — and both answers were dropped by
 * the citation gate. The model is shown `[f7]` now and the id is
 * restored in code, so the wire contract does not move.
 */
import { buildFactIndex, handlesOf } from '../src/synthesize/fact-index';
import { expandCitationHandles, resolveCitations } from '../src/synthesize/synthesize.helpers';
import type { SearchHit } from '../src/search/search.types';

const hit = (name: string, facts: Array<[string, string, string]>): SearchHit =>
  ({
    entityId: `knowledge_entity:${name}`,
    entityType: 'person',
    canonicalName: name,
    externalRefs: {},
    score: 1,
    facts: facts.map(([id, predicate, object]) => ({
      factId: `knowledge_fact:${id}`,
      predicate,
      object,
      confidence: 0.9,
      score: 1,
      validFrom: '2026-09-01T00:00:00.000Z',
      status: 'active',
    })),
  }) as unknown as SearchHit;

describe('citation handles', () => {
  const res = buildFactIndex([
    hit('Alice', [['a1', 'complained_about', 'tariff']]),
    hit('Artem', [
      ['b1', 'intent', 'relocating his team'],
      ['b2', 'status', 'lead engineer'],
    ]),
  ]);

  it('every fact line opens with a handle numbered in rendered order; the index stays keyed by id', () => {
    expect(res.factLines.map((l) => l.slice(0, 5))).toEqual(['[f1] ', '[f2] ', '[f3] ']);
    expect([...handlesOf(res.factIndex).entries()]).toEqual([
      ['f1', 'knowledge_fact:a1'],
      ['f2', 'knowledge_fact:b1'],
      ['f3', 'knowledge_fact:b2'],
    ]);
    expect([...res.factIndex.keys()]).toEqual([
      'knowledge_fact:a1',
      'knowledge_fact:b1',
      'knowledge_fact:b2',
    ]);
    expect(res.factLines[1]).not.toContain('knowledge_fact:');
  });

  it('expands handles in the answer text and the cited array back to ids; an unknown handle is left to fall out', () => {
    const out = expandCitationHandles(
      {
        answer: "Artem's team is relocating [f2]. He is a lead engineer [f3] and [f9].",
        citedFactIds: ['f2', '[f3]', 'f9'],
      },
      res.factIndex,
    );
    expect(out.answer).toBe(
      "Artem's team is relocating [knowledge_fact:b1]. He is a lead engineer [knowledge_fact:b2] and [f9].",
    );
    expect(out.citedFactIds).toEqual(['knowledge_fact:b1', 'knowledge_fact:b2', 'f9']);
    expect(
      resolveCitations(out.citedFactIds, out.answer, res.factIndex).map((c) => c.factId),
    ).toEqual(['knowledge_fact:b1', 'knowledge_fact:b2']);
  });

  it('the resolver also reads a raw handle, so a path that skipped expansion still cites', () => {
    const cites = resolveCitations(['f1'], 'tariff [f1]', res.factIndex);
    expect(cites.map((c) => c.canonicalName)).toEqual(['Alice']);
  });

  it('a map that did not come from buildFactIndex has no handles and expands nothing', () => {
    const foreign = new Map(res.factIndex);
    expect(handlesOf(foreign).size).toBe(0);
    expect(expandCitationHandles({ answer: 'x [f1]', citedFactIds: ['f1'] }, foreign).answer).toBe(
      'x [f1]',
    );
  });
});
