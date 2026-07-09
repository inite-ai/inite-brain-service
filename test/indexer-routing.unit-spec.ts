/**
 * Unit-test for the router's rule layers (L0 explicit/vertical/alwaysRun,
 * L1 keywords) and the cosine helper backing L2.
 */
import {
  cosineSimilarity,
  IndexerBinding,
  routeByRules,
} from '../src/indexers/routing';

const binding = (
  indexerId: string,
  over: Partial<IndexerBinding> = {},
): IndexerBinding => ({
  indexerId,
  packVersion: '1.0.0',
  mode: 'dedicated',
  description: `${indexerId} pack`,
  ...over,
});

describe('routeByRules', () => {
  it('virtual bindings never route (they ride the union call)', () => {
    const out = routeByRules(
      [binding('real_estate', { mode: 'virtual' })],
      { vertical: 'crm', head: 'zoned residential' },
    );
    expect(out.selected).toEqual([]);
    expect(out.needEmbedding).toEqual([]);
  });

  it('L0: explicit request selects', () => {
    const out = routeByRules([binding('medical')], {
      vertical: 'crm',
      head: '',
      requested: ['medical'],
    });
    expect(out.selected.map((b) => b.indexerId)).toEqual(['medical']);
  });

  it('L0: vertical subscription selects', () => {
    const out = routeByRules(
      [binding('meetings', { relevance: { verticals: ['calendar'] } })],
      { vertical: 'calendar', head: '' },
    );
    expect(out.selected.map((b) => b.indexerId)).toEqual(['meetings']);
  });

  it('L0: alwaysRun bypasses everything', () => {
    const out = routeByRules(
      [binding('audit', { relevance: { alwaysRun: true } })],
      { vertical: 'x', head: '' },
    );
    expect(out.selected.map((b) => b.indexerId)).toEqual(['audit']);
  });

  it('L1: keyword in document head selects, case-insensitively', () => {
    const out = routeByRules(
      [binding('real_estate', { relevance: { keywords: ['Zoned', 'listing'] } })],
      { vertical: 'crm', head: 'The property is ZONED residential.' },
    );
    expect(out.selected.map((b) => b.indexerId)).toEqual(['real_estate']);
  });

  it('undecided binding WITH description goes to the embedding layer', () => {
    const out = routeByRules(
      [
        binding('legal', {
          relevance: { keywords: ['contract'], description: 'legal documents' },
        }),
      ],
      { vertical: 'crm', head: 'weekly standup notes' },
    );
    expect(out.selected).toEqual([]);
    expect(out.needEmbedding.map((b) => b.indexerId)).toEqual(['legal']);
  });

  it('dedicated binding with NO relevance runs only when requested', () => {
    const b = binding('hr');
    expect(routeByRules([b], { vertical: 'crm', head: 'hr text' }).selected).toEqual([]);
    expect(
      routeByRules([b], { vertical: 'crm', head: '', requested: ['hr'] }).selected,
    ).toHaveLength(1);
  });
});

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('empty / zero vectors → 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
