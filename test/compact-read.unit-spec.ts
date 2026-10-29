/**
 * What search_knowledge and get_entity_timeline hand a model by default
 * (src/mcp/compact-read.ts): the evidence, not the engine's bookkeeping.
 * Measured on a key-less stand, where the raw turns cost 138 tokens: one
 * search answer 3683 → ~440 compact → 35 on average in focus (the
 * default); one timeline 2784 → ~515.
 */
import { compactSearch, compactTimeline, renderFocus } from '../src/mcp/compact-read';
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

describe('renderFocus — the fovea: only what the query is about, in its cheapest form', () => {
  const chars = (s: string) => s.length;
  const fact = (id: string, predicate: string, object: string, score: number) => ({
    factId: id,
    predicate,
    object,
    confidence: 0.9,
    validFrom: '2026-10-05T10:00:00.000Z',
    status: 'active',
    score,
  });
  const sasha = hit({
    facts: [
      fact('knowledge_fact:moto', 'owns_motorcycle', 'no motorcycle anymore', 0.25),
      fact('knowledge_fact:sold', 'sold', 'Kawasaki Ninja motorcycle', 0.21),
      fact('knowledge_fact:a', 'founded_startup', 'INITE', 0.14),
      fact('knowledge_fact:b', 'music_service', 'Yandex Music', 0.13),
      fact('knowledge_fact:c', 'name', 'Sasha', 0.13),
    ] as never,
  });
  const turn = {
    episodeId: 'episode:t5',
    text: 'I sold the Ninja, no motorcycle anymore.',
    at: '2026-10-05T10:00:00.000Z',
    speaker: 'sasha',
  };

  it('keeps the facts standing out of this answer noise floor, and says how many it left', () => {
    const text = renderFocus({ out: { results: [sasha] }, sources: new Map(), tokens: chars });
    expect(text).toContain('owns_motorcycle = no motorcycle anymore');
    expect(text).toContain('sold = Kawasaki Ninja motorcycle');
    expect(text).not.toContain('founded_startup');
    expect(text).toContain('(+3 more: detail "compact")');
  });

  it('quotes the source turn when it is cheaper than the facts read from it', () => {
    const sources = new Map([
      ['knowledge_fact:moto', [turn]],
      ['knowledge_fact:sold', [turn]],
    ]);
    const text = renderFocus({ out: { results: [sasha] }, sources, tokens: chars });
    expect(text).toContain('[2026-10-05] sasha: "I sold the Ninja, no motorcycle anymore."');
    expect(text).not.toContain('owns_motorcycle');
  });

  it('keeps the facts when the turn they came from is longer', () => {
    const long = { ...turn, text: `${'Well, long story. '.repeat(10)}I sold it.` };
    const sources = new Map([['knowledge_fact:moto', [long]]]);
    const text = renderFocus({ out: { results: [sasha] }, sources, tokens: chars });
    expect(text).toContain('owns_motorcycle = no motorcycle anymore');
    expect(text).not.toContain('long story');
  });

  it('never spends more on evidence than the raw turns it came from', () => {
    const sources = new Map([
      ['knowledge_fact:moto', [turn]],
      ['knowledge_fact:sold', [turn]],
    ]);
    const text = renderFocus({ out: { results: [sasha] }, sources, tokens: chars });
    const evidence = text.split('\n').filter((l) => !l.startsWith('(+'));
    expect(evidence.join('\n').length).toBeLessThanOrEqual(
      `[2026-10-05] sasha: "${turn.text}"`.length,
    );
  });

  it('shows a link only when it connects the kept entities', () => {
    const diego = hit({
      entityId: 'knowledge_entity:diego',
      canonicalName: 'Diego',
      relations: [
        { kind: 'colleague_of', peer: 'Ana', peerType: 'customer', direction: 'out' },
        { kind: 'works_at', peer: 'Orbital Dynamics', peerType: 'other', direction: 'out' },
      ],
      facts: [fact('knowledge_fact:d', 'lives_in', 'Braga', 0.25)] as never,
    } as never);
    const me = hit({
      facts: [fact('knowledge_fact:me', 'lives_in', 'Porto', 0.24)] as never,
    });
    const text = renderFocus({ out: { results: [me, diego] }, sources: new Map(), tokens: chars });
    expect(text).toContain('Ana sibling_of Sasha');
    expect(text).toContain('Diego colleague_of Ana');
    expect(text).not.toContain('Orbital Dynamics');
    expect(text).not.toContain('MacBook');
  });

  it('keeps rank order: a quote stands where its best fact ranked', () => {
    const sources = new Map([['knowledge_fact:moto', [turn]]]);
    const ranked = hit({
      facts: [
        fact(
          'knowledge_fact:moto',
          'owns_motorcycle',
          'no motorcycle anymore as of this week',
          0.3,
        ),
        fact('knowledge_fact:x', 'sold', 'Ninja', 0.29),
      ] as never,
    });
    const lines = renderFocus({ out: { results: [ranked] }, sources, tokens: chars }).split('\n');
    expect(lines[0]).toContain('I sold the Ninja');
    expect(lines[1]).toContain('sold = Ninja');
  });

  it('never quotes a competing or ended fact — the turn cannot carry its status', () => {
    const sources = new Map([['knowledge_fact:c', [turn]]]);
    const disputed = hit({
      facts: [
        {
          ...fact('knowledge_fact:c', 'owns_motorcycle', 'no motorcycle anymore, sold it', 0.3),
          status: 'competing',
        },
      ] as never,
    });
    const text = renderFocus({ out: { results: [disputed] }, sources, tokens: chars });
    expect(text).toContain('[competing]');
    expect(text).not.toContain('I sold the Ninja');
  });

  it('shows a dispute whole, whatever the other side scored', () => {
    const meridian = hit({
      canonicalName: 'Meridian',
      relations: [],
      facts: [
        { ...fact('knowledge_fact:p', 'payout_cutoff', '17:00 UTC', 0.4), status: 'competing' },
        fact('knowledge_fact:r', 'rate_limit', '50 rpm', 0.12),
        fact('knowledge_fact:s', 'sandbox', 'yes', 0.11),
        { ...fact('knowledge_fact:d', 'payout_cutoff', '16:30 UTC', 0.1), status: 'competing' },
      ] as never,
    });
    const text = renderFocus({ out: { results: [meridian] }, sources: new Map(), tokens: chars });
    expect(text).toContain('17:00 UTC');
    expect(text).toContain('16:30 UTC');
    expect(text).not.toContain('rate_limit');
  });

  it('hands on what a linked source answered, marked as not memory, with its observation ref', () => {
    const linked = [
      {
        connectionId: 'source_connection:j',
        connector: 'jira',
        observationRef: 'tool_observation:o1',
        hits: [
          { externalId: 'LS-12', title: 'LS-12 payout retries', snippet: 'Backoff capped at 5' },
        ],
      },
    ];
    const alone = renderFocus({ out: { results: [], linked }, sources: new Map(), tokens: chars });
    expect(alone).toBe(
      '[jira, not in memory, tool_observation:o1] LS-12 payout retries — Backoff capped at 5',
    );
    const withFacts = renderFocus({
      out: { results: [sasha], linked },
      sources: new Map(),
      tokens: chars,
    });
    expect(withFacts).toContain('owns_motorcycle');
    expect(withFacts).toContain('LS-12 payout retries');
  });

  it('says nothing matched — or that the search was degraded, which is not the same', () => {
    expect(renderFocus({ out: { results: [] }, sources: new Map(), tokens: chars })).toBe(
      'No facts in memory match this question.',
    );
    expect(
      renderFocus({
        out: { results: [], degraded: ['embedder_unavailable'] },
        sources: new Map(),
        tokens: chars,
      }),
    ).toContain('search degraded: embedder_unavailable');
  });
});
