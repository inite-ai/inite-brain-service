/**
 * What search_knowledge and get_entity_timeline hand a model by default
 * (src/mcp/compact-read.ts): the evidence, not the engine's bookkeeping.
 * Measured on a key-less stand: one search answer 3545 → ~440 tokens,
 * one timeline 2784 → ~515, where the raw turns behind them cost 138.
 */
import { compactSearch, compactTimeline } from '../src/mcp/compact-read';
import type { SearchHit } from '../src/search/search.types';
import type { TimelineEvent } from '../src/entities/entities.service';

/** The driver's DateTime: an object with toDate(), not a string (the #814 trap). */
const driverDate = (iso: string) => ({ toDate: () => new Date(iso) });

const hit = (over: Partial<SearchHit> = {}): SearchHit =>
  ({
    entityId: 'knowledge_entity:sasha',
    entityType: 'customer',
    canonicalName: 'Sasha',
    externalRefs: { 'user__sasha::u::sasha': 'sasha' },
    relations: [
      {
        kind: 'lives_in',
        peer: 'Porto',
        peerType: 'location',
        peerId: 'knowledge_entity:porto',
        edgeId: 'knowledge_edge:1',
        direction: 'out',
      },
      {
        kind: 'owns',
        peer: 'MacBook Pro',
        peerType: 'asset',
        peerId: 'knowledge_entity:mbp',
        edgeId: 'knowledge_edge:2',
        direction: 'out',
      },
      {
        kind: 'sibling_of',
        peer: 'Ana',
        peerType: 'customer',
        peerId: 'knowledge_entity:ana',
        edgeId: 'knowledge_edge:3',
        direction: 'in',
      },
    ],
    facts: [
      {
        factId: 'knowledge_fact:1',
        predicate: 'lives_in',
        object: 'Porto',
        confidence: 0.95,
        validFrom: driverDate('2026-10-01T00:00:00Z'),
        status: 'active',
        sourceKey: 'chat:core',
        score: 0.4,
        breakdown: { fusedScore: 0.5, decay: 1, usage: { readCount: 3 } },
      },
      {
        factId: 'knowledge_fact:2',
        predicate: 'gym_plan',
        object: 'premium',
        confidence: 0.8,
        validFrom: '2026-09-01T00:00:00.000Z',
        validUntil: '2026-10-15T00:00:00.000Z',
        status: 'competing',
        score: 0.2,
      },
      {
        factId: 'knowledge_fact:3',
        predicate: 'name',
        object: 'Sasha',
        confidence: 0.95,
        validFrom: '1970-01-01T00:00:00.000Z',
        status: 'active',
        score: 0.1,
      },
    ],
    score: 0.4,
    ...over,
  }) as unknown as SearchHit;

describe('compactSearch', () => {
  it('keeps name, entity id, predicate, value and the day a fact holds from', () => {
    const out = compactSearch({ results: [hit()] });
    expect(out.results[0]).toMatchObject({
      canonicalName: 'Sasha',
      entityId: 'knowledge_entity:sasha',
    });
    expect(out.results[0]?.facts[0]).toEqual({
      predicate: 'lives_in',
      object: 'Porto',
      since: '2026-10-01',
    });
  });

  it('drops the bookkeeping: scores, breakdowns, fact and edge ids, trust keys, confidence', () => {
    const text = JSON.stringify(compactSearch({ results: [hit()] }));
    for (const key of [
      'breakdown',
      'score',
      'factId',
      'edgeId',
      'peerId',
      'sourceKey',
      'confidence',
      'externalRefs',
    ]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it('shows a status only when it is not the current value, and the end of an ended one', () => {
    const facts = compactSearch({ results: [hit()] }).results[0]!.facts;
    expect(facts[1]).toEqual({
      predicate: 'gym_plan',
      object: 'premium',
      since: '2026-09-01',
      until: '2026-10-15',
      status: 'competing',
    });
    expect(facts[0]).not.toHaveProperty('status');
  });

  it('drops the unknown-start sentinel rather than reading it as 1970', () => {
    expect(compactSearch({ results: [hit()] }).results[0]!.facts[2]).not.toHaveProperty('since');
  });

  it('lists relations as one line each, without those restating a listed fact', () => {
    expect(compactSearch({ results: [hit()] }).results[0]!.relations).toEqual([
      '→ owns MacBook Pro',
      '← sibling_of Ana',
    ]);
  });

  it('passes degraded and linked through, and is far smaller than the full response', () => {
    const full = { results: [hit(), hit({ canonicalName: 'Ana' })], degraded: ['rerank'] };
    const out = compactSearch(full);
    expect(out.degraded).toEqual(['rerank']);
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(full).length / 2);
  });
});

describe('compactTimeline', () => {
  const events = [
    {
      type: 'fact.recorded',
      at: '2026-10-29T21:47:43.046Z',
      validFrom: '2026-10-02T10:00:00.000Z',
      factId: 'knowledge_fact:tp',
      predicate: 'work_laptop',
      object: 'ThinkPad X1 Carbon',
      source: {
        documentId: 'source_document:x',
        episodeIds: ['episode:y'],
        indexers: [{ model: 'harness' }],
      },
      confidence: 0.95,
    },
    {
      type: 'fact.retracted',
      at: '2026-10-06T10:00:00.000Z',
      factId: 'knowledge_fact:tp',
      retractedBy: 'resolver',
      reason: 'superseded',
      supersededBy: 'knowledge_fact:mbp',
    },
  ] as unknown as TimelineEvent[];

  it('keeps each event value and day, and links a retraction to its fact', () => {
    expect(compactTimeline({ entityId: 'knowledge_entity:sasha', events })).toEqual({
      entityId: 'knowledge_entity:sasha',
      events: [
        {
          type: 'recorded',
          id: 'knowledge_fact:tp',
          predicate: 'work_laptop',
          object: 'ThinkPad X1 Carbon',
          since: '2026-10-02',
        },
        {
          type: 'retracted',
          id: 'knowledge_fact:tp',
          on: '2026-10-06',
          supersededBy: 'knowledge_fact:mbp',
          reason: 'superseded',
        },
      ],
    });
  });

  it('drops the provenance blob get_fact_provenance serves', () => {
    const text = JSON.stringify(compactTimeline({ entityId: 'e', events }));
    expect(text).not.toContain('source_document');
    expect(text).not.toContain('confidence');
  });
});
