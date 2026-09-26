import {
  planExtractionGroups,
  renderGroup,
  splitGroupResult,
  type GroupDoc,
} from '../src/documents/extraction-group';
import { buildConversationContext } from '../src/ai/extractor-internals/prompts';

const doc = (id: string, text: string, day: number, extra: Partial<GroupDoc> = {}): GroupDoc => ({
  id,
  text,
  occurredAt: new Date(Date.UTC(2026, 8, day, 10)),
  chunkCount: 1,
  ...extra,
});

describe('planExtractionGroups', () => {
  const budget = { maxChars: 100, maxDocs: 3 };

  it('reads one conversation of one user together, oldest first', () => {
    const groups = planExtractionGroups(
      [
        doc('b', 'second', 2, { conversationId: 'c', userId: 'u' }),
        doc('a', 'first', 1, { conversationId: 'c', userId: 'u' }),
      ],
      budget,
    );
    expect(groups.map((g) => g.map((d) => d.id))).toEqual([['a', 'b']]);
  });

  it('never mixes users or conversations', () => {
    const groups = planExtractionGroups(
      [
        doc('a', 'x', 1, { conversationId: 'c', userId: 'u1' }),
        doc('b', 'y', 2, { conversationId: 'c', userId: 'u2' }),
        doc('c', 'z', 3, { conversationId: 'd', userId: 'u1' }),
      ],
      budget,
    );
    expect(groups.map((g) => g.map((d) => d.id)).sort()).toEqual([['a'], ['b'], ['c']]);
  });

  it('splits at the size and count budget; a big or chunked document reads alone', () => {
    const groups = planExtractionGroups(
      [
        doc('a', 'x'.repeat(40), 1),
        doc('b', 'x'.repeat(40), 2),
        doc('c', 'x'.repeat(40), 3),
        doc('big', 'x'.repeat(150), 4),
        doc('chunked', 'x', 5, { chunkCount: 3 }),
        doc('d', 'x', 6),
        doc('e', 'x', 7),
        doc('f', 'x', 8),
        doc('g', 'x', 9),
      ],
      budget,
    );
    expect(groups.map((g) => g.map((d) => d.id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['big'],
      ['chunked'],
      ['d', 'e', 'f'],
      ['g'],
    ]);
  });
});

describe('renderGroup', () => {
  it('puts every turn under a dated header naming its speaker', () => {
    const r = renderGroup([
      doc('a', 'Budget is 4000.', 1, { speakerName: 'Mike', speakerIsUser: true }),
      doc('b', 'Noted.', 2, { speakerName: 'Claude', addresseeName: 'Mike' }),
    ]);
    expect(r.text).toBe(
      '[#1 · 2026-09-01 · Mike]\nBudget is 4000.\n\n[#2 · 2026-09-02 · Claude]\nNoted.',
    );
    expect(r.turns).toEqual([
      { label: '#1', speakerName: 'Mike', speakerIsUser: true, addresseeName: undefined },
      { label: '#2', speakerName: 'Claude', speakerIsUser: undefined, addresseeName: 'Mike' },
    ]);
  });

  it('frames the turns for the extractor instead of one speaker', () => {
    const { turns } = renderGroup([
      doc('a', 'x', 1, { speakerName: 'Mike', speakerIsUser: true }),
      doc('b', 'y', 2, { speakerName: 'Ana' }),
    ]);
    const prefix = buildConversationContext({ speakerName: 'ignored', turns });
    expect(prefix).toContain('The input holds 2 turns');
    expect(prefix).toContain('#1: "Mike" (the user this memory belongs to)');
    expect(prefix).toContain('#2: "Ana"');
    expect(prefix).not.toContain('ignored');
    expect(prefix.endsWith('CURRENT TURNS:\n')).toBe(true);
  });
});

describe('splitGroupResult', () => {
  const docs = [
    doc('a', 'Acme budget is 4000 euro.', 1),
    doc('b', 'Call with Acme moved to Thursday. Marta joined.', 2),
    doc('c', 'No — the Acme budget is 2500 euro now.', 3),
  ];

  it('files each claim under the turn its clause was copied from, entities re-indexed', () => {
    const parts = splitGroupResult(docs, {
      entities: [
        { name: 'Acme', type: 'customer' },
        { name: 'Marta', type: 'staff' },
        { name: 'Thursday call', type: 'topic' },
      ],
      facts: [
        {
          entityIndex: 0,
          predicate: 'budget',
          object: '4000 euro',
          confidence: 0.9,
          clause: 'Acme budget is 4000 euro.',
        },
        {
          entityIndex: 0,
          predicate: 'budget',
          object: '2500 euro',
          confidence: 0.9,
          clause: 'the Acme budget is 2500 euro now',
        },
        { entityIndex: 1, predicate: 'joined', object: 'joined', confidence: 0.8 },
      ],
      edges: [
        {
          fromEntityIndex: 1,
          toEntityIndex: 0,
          kind: 'works_with',
          confidence: 0.7,
          clause: 'Marta joined.',
        },
      ],
    });
    expect(parts[0]!.facts.map((f) => f.object)).toEqual(['4000 euro']);
    expect(parts[2]!.facts.map((f) => f.object)).toEqual(['2500 euro']);
    // No clause: the entity name places it.
    expect(parts[1]!.facts.map((f) => f.predicate)).toEqual(['joined']);
    expect(parts[1]!.entities.map((e) => e.name)).toEqual(['Acme', 'Marta']);
    expect(parts[1]!.facts[0]!.entityIndex).toBe(1);
    expect(parts[1]!.edges[0]).toMatchObject({ fromEntityIndex: 1, toEntityIndex: 0 });
    expect(parts[0]!.entities.map((e) => e.name)).toEqual(['Acme']);
    // A claim-less entity goes to the turn that names it; here none does.
    expect(parts.flatMap((p) => p.entities.map((e) => e.name))).not.toContain('Thursday call');
  });

  it('the latest turn owns words said twice; an unplaceable claim goes to the last turn', () => {
    const parts = splitGroupResult(
      [doc('a', 'Acme is a client.', 1), doc('b', 'Acme is a client.', 2)],
      {
        entities: [{ name: 'Acme', type: 'customer' }],
        facts: [
          {
            entityIndex: 0,
            predicate: 'is',
            object: 'client',
            confidence: 0.9,
            clause: 'Acme is a client.',
          },
          {
            entityIndex: 0,
            predicate: 'tier',
            object: 'gold',
            confidence: 0.9,
            clause: 'paraphrased away',
          },
        ],
        edges: [],
      },
    );
    expect(parts[0]!.facts).toEqual([]);
    expect(parts[1]!.facts.map((f) => f.object)).toEqual(['client', 'gold']);
  });
});
