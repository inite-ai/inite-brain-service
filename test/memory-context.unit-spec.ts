/**
 * The memory context of an extraction (src/ai/extractor-internals/
 * memory-context.ts + the parser/grounding seams that consume it):
 *  - rendering: every section only when it has content; '' for nothing;
 *  - the digest partitions the extraction cache by what the model read;
 *  - handles map back to record ids, invented handles vanish;
 *  - parseEntities/parseRawFacts carry known / eventTime / supersedes;
 *  - a pinned entity is grounded by construction (the extractor writes
 *    the known name for a short mention).
 */
import {
  knownEntityId,
  memoryContextDigest,
  normalizeHandle,
  renderMemoryContext,
  supersededFactIds,
  type MemoryContext,
} from '../src/ai/extractor-internals/memory-context';
import {
  groundEntities,
  parseEntities,
  parseEventTime,
  parseRawFacts,
} from '../src/ai/extractor-internals/grounding';

const ctx: MemoryContext = {
  occurredAt: '2026-09-16T11:00:00Z',
  recentTurns: [
    { at: '2026-09-10T10:00:00Z', speaker: 'Mike', text: 'Созвон с Rui Almeida из RK Imóveis.' },
  ],
  entities: [
    { handle: 'e1', id: 'knowledge_entity:rk', name: 'RK Imóveis', type: 'customer' },
    { handle: 'e2', id: 'knowledge_entity:rui', name: 'Rui Almeida', type: 'customer' },
  ],
  facts: [
    {
      handle: 'm1',
      id: 'knowledge_fact:b4000',
      entityHandle: 'e1',
      predicate: 'monthly_budget',
      object: '4000 евро в месяц',
      since: '2026-09-10',
    },
  ],
  predicates: ['monthly_budget', 'project_start'],
};

describe('renderMemoryContext', () => {
  it('renders the date, the conversation, the handles and the vocabulary, then CURRENT TURN', () => {
    const out = renderMemoryContext(ctx);
    expect(out).toContain('TURN DATE: 2026-09-16');
    expect(out).toContain('[2026-09-10] Mike: Созвон с Rui Almeida из RK Imóveis.');
    expect(out).toContain('[e1] RK Imóveis (customer)');
    expect(out).toContain('[m1] e1 · monthly_budget: 4000 евро в месяц (since 2026-09-10)');
    expect(out).toContain('monthly_budget, project_start');
    expect(out.endsWith('CURRENT TURN:\n')).toBe(true);
  });

  it('is empty for no context and for an empty one — the input is byte-identical', () => {
    expect(renderMemoryContext(undefined)).toBe('');
    expect(renderMemoryContext({ recentTurns: [], entities: [], facts: [], predicates: [] })).toBe(
      '',
    );
  });

  it('a date alone still anchors the turn', () => {
    const out = renderMemoryContext({
      occurredAt: '2026-09-16T11:00:00Z',
      recentTurns: [],
      entities: [],
      facts: [],
      predicates: [],
    });
    expect(out).toContain('TURN DATE: 2026-09-16');
    expect(out).not.toContain('KNOWN ENTITIES');
  });
});

describe('memoryContextDigest', () => {
  it('changes with the ids the model read and is empty for no context', () => {
    expect(memoryContextDigest(undefined)).toBe('');
    const a = memoryContextDigest(ctx);
    const b = memoryContextDigest({
      ...ctx,
      facts: [{ ...ctx.facts[0]!, id: 'knowledge_fact:b2500' }],
    });
    expect(a).not.toBe(b);
    expect(memoryContextDigest({ ...ctx })).toBe(a);
  });
});

describe('handles', () => {
  it('normalise with or without brackets, case-insensitively, per kind', () => {
    expect(normalizeHandle('[e2]', 'e')).toBe('e2');
    expect(normalizeHandle(' E2 ', 'e')).toBe('e2');
    expect(normalizeHandle('m03', 'm')).toBe('m3');
    expect(normalizeHandle('e2', 'm')).toBeNull();
    expect(normalizeHandle('knowledge_entity:rk', 'e')).toBeNull();
    expect(normalizeHandle(7, 'e')).toBeNull();
  });

  it('map to record ids; an invented handle maps to nothing', () => {
    expect(knownEntityId(ctx, 'e2')).toBe('knowledge_entity:rui');
    expect(knownEntityId(ctx, 'e9')).toBeUndefined();
    expect(knownEntityId(undefined, 'e1')).toBeUndefined();
    expect(supersededFactIds(ctx, ['m1', '[m1]', 'm7', 'x'])).toEqual(['knowledge_fact:b4000']);
    expect(supersededFactIds(ctx, 'm1')).toEqual([]);
  });
});

describe('the parsers carry the memory-context fields', () => {
  const raw = {
    entities: [
      { name: 'Rui', type: 'customer', canonical: null, known: 'e2' },
      { name: 'Nobody', type: 'other', canonical: null, known: 'e42' },
    ],
    facts: [
      {
        entityIndex: 0,
        clauseIndex: 0,
        predicate: 'monthly_budget',
        valueSpan: '2500 евро в месяц',
        confidence: 0.95,
        eventTime: null,
        supersedes: ['m1', 'm9'],
      },
      {
        entityIndex: 0,
        clauseIndex: 0,
        predicate: 'decision_date',
        valueSpan: '19 сентября',
        confidence: 0.9,
        eventTime: '2026-09-19',
        supersedes: [],
      },
      {
        entityIndex: 0,
        clauseIndex: 0,
        predicate: 'bad_day',
        valueSpan: 'x',
        confidence: 0.9,
        eventTime: '2026-02-30',
        supersedes: [],
      },
    ],
  };

  it('parseEntities pins known handles to ids and drops invented ones', () => {
    const ents = parseEntities(raw, ctx);
    expect(ents[0]).toMatchObject({ name: 'Rui', known: 'knowledge_entity:rui' });
    expect(ents[1]).not.toHaveProperty('known');
  });

  it('parseRawFacts keeps a real day, drops an impossible one, maps supersedes', () => {
    const facts = parseRawFacts(raw, 2, ctx);
    expect(facts[0]).toMatchObject({ supersedes: ['knowledge_fact:b4000'] });
    expect(facts[0]).not.toHaveProperty('eventTime');
    expect(facts[1]).toMatchObject({ eventTime: '2026-09-19' });
    expect(facts[1]).not.toHaveProperty('supersedes');
    expect(facts[2]).not.toHaveProperty('eventTime');
  });

  it('parseEventTime accepts YYYY-MM-DD (with a time tail) and nothing else', () => {
    expect(parseEventTime('2026-09-19')).toBe('2026-09-19');
    expect(parseEventTime('2026-09-19T00:00:00Z')).toBe('2026-09-19');
    expect(parseEventTime('19 сентября')).toBeUndefined();
    expect(parseEventTime('2026-13-01')).toBeUndefined();
    expect(parseEventTime(null)).toBeUndefined();
  });

  it('groundEntities passes a pinned entity even when its name is not in the turn', () => {
    const mask = groundEntities('Rui сказал, что решение примет совет директоров.', [
      { name: 'Rui Almeida', type: 'customer', known: 'knowledge_entity:rui' },
      { name: 'Rui Almeida', type: 'customer' },
      { name: 'совет директоров', type: 'other' },
    ]);
    expect(mask).toEqual([true, false, true]);
  });
});
