import {
  planExtractionGroups,
  releaseSettled,
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
        doc('d', 'w', 4, { conversationId: 'c', userId: 'u1' }),
      ],
      budget,
    );
    expect(groups.map((g) => g.map((d) => d.id)).sort()).toEqual([['a', 'd'], ['b'], ['c']]);
  });

  it('splits at the size and count budget; a big or chunked turn reads alone', () => {
    const t = (id: string, text: string, day: number, extra: Partial<GroupDoc> = {}) =>
      doc(id, text, day, { conversationId: 'c', ...extra });
    const groups = planExtractionGroups(
      [
        t('a', 'x'.repeat(40), 1),
        t('b', 'x'.repeat(40), 2),
        t('c', 'x'.repeat(40), 3),
        t('big', 'x'.repeat(150), 4),
        t('chunked', 'x', 5, { chunkCount: 3 }),
        t('d', 'x', 6),
        t('e', 'x', 7),
        t('f', 'x', 8),
        t('g', 'x', 9),
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

  it('reads every standalone document alone — unrelated notes are not one text', () => {
    const groups = planExtractionGroups([doc('n1', 'x', 1), doc('n2', 'y', 2)], budget);
    expect(groups.map((g) => g.map((d) => d.id))).toEqual([['n1'], ['n2']]);
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

describe('releaseSettled', () => {
  const rule = { settleMs: 120_000, maxWaitMs: 600_000, maxChars: 100 };
  const now = new Date(Date.UTC(2026, 8, 25, 12, 0, 0));
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const turn = (id: string, conv: string, arrivedSecondsAgo: number, text = 'x') =>
    doc(id, text, 25, { conversationId: conv, arrivedAt: ago(arrivedSecondsAgo) });

  it('holds a conversation still talking and says when it goes quiet', () => {
    const r = releaseSettled([turn('a', 'c', 90), turn('b', 'c', 30)], now, rule);
    expect(r.ready).toEqual([]);
    expect(r.nextAt).toEqual(new Date(ago(30).getTime() + 120_000));
  });

  it('reads it once quiet, once its oldest turn waited long enough, or once it fills a group', () => {
    const quiet = releaseSettled([turn('a', 'c', 400), turn('b', 'c', 130)], now, rule);
    expect(quiet.ready.map((d) => d.id)).toEqual(['a', 'b']);
    const waited = releaseSettled([turn('a', 'c', 601), turn('b', 'c', 5)], now, rule);
    expect(waited.ready.map((d) => d.id)).toEqual(['a', 'b']);
    const full = releaseSettled([turn('a', 'c', 5, 'x'.repeat(100))], now, rule);
    expect(full.ready.map((d) => d.id)).toEqual(['a']);
  });

  it('an urgent turn reads its whole conversation at once, still talking or not', () => {
    const r = releaseSettled(
      [turn('a', 'c', 90), { ...turn('b', 'c', 1), urgent: true }, turn('z', 'other', 5)],
      now,
      rule,
    );
    expect(r.ready.map((d) => d.id)).toEqual(['a', 'b']);
    // The other conversation is still held.
    expect(r.nextAt).toEqual(new Date(ago(5).getTime() + 120_000));
  });

  it('a standalone document is ready at once', () => {
    const r = releaseSettled([doc('n', 'note', 25, { arrivedAt: ago(1) })], now, rule);
    expect(r.ready.map((d) => d.id)).toEqual(['n']);
    expect(r.nextAt).toBeUndefined();
  });
});
