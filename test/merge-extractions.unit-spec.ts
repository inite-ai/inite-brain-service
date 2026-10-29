import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import type { ExtractionResult } from '../src/ai/extractor-internals/types';

/**
 * The union step. Every pass numbers entities independently, so facts and edges
 * addressing them BY POSITION must be renumbered onto the merged table — the
 * pre-existing multi-pass merge carried raw indices across and silently
 * mis-attributed facts whenever two passes ordered entities differently.
 */
describe('mergeExtractions', () => {
  const pass = (
    entities: Array<[string, string]>,
    facts: Array<[number, string, string]>,
    edges: Array<[number, string, number]> = [],
  ): ExtractionResult => ({
    entities: entities.map(([name, type]) => ({ name, type: type as never })),
    facts: facts.map(([entityIndex, predicate, object]) => ({
      entityIndex,
      predicate,
      object,
      confidence: 0.9,
    })),
    edges: edges.map(([fromEntityIndex, kind, toEntityIndex]) => ({
      fromEntityIndex,
      kind,
      toEntityIndex,
      confidence: 0.9,
    })),
  });

  it('remaps fact entity indices onto the merged entity table', () => {
    // Pass A: [Melanie, Caroline]; Pass B: [Caroline] — B's index 0 is Caroline,
    // which sits at index 1 after the merge. Carrying the raw index would
    // attribute B's fact to Melanie.
    const merged = mergeExtractions([
      pass(
        [
          ['Melanie', 'customer'],
          ['Caroline', 'customer'],
        ],
        [[0, 'painted', 'a sunset']],
      ),
      pass([['Caroline', 'customer']], [[0, 'adopted', 'a dog']]),
    ]);
    expect(merged.entities.map((e) => e.name)).toEqual(['Melanie', 'Caroline']);
    const adopted = merged.facts.find((f) => f.predicate === 'adopted');
    expect(merged.entities[adopted!.entityIndex]!.name).toBe('Caroline');
  });

  it('remaps edge endpoints and dedupes edges by entity identity, not position', () => {
    const merged = mergeExtractions([
      pass(
        [
          ['Melanie', 'customer'],
          ['Acme', 'project'],
        ],
        [],
        [[0, 'works_at', 1]],
      ),
      // Reversed ordering — the same edge, different indices.
      pass(
        [
          ['Acme', 'project'],
          ['Melanie', 'customer'],
        ],
        [],
        [[1, 'works_at', 0]],
      ),
    ]);
    expect(merged.edges).toHaveLength(1);
    expect(merged.entities[merged.edges[0]!.fromEntityIndex]!.name).toBe('Melanie');
    expect(merged.entities[merged.edges[0]!.toEntityIndex]!.name).toBe('Acme');
  });

  it('unions facts across passes and drops semantic duplicates', () => {
    const merged = mergeExtractions([
      pass([['Tim', 'customer']], [[0, 'read', 'The Hobbit']]),
      pass(
        [['Tim', 'customer']],
        [
          [0, 'read', 'The Hobbit'],
          [0, 'read', 'Dune'],
        ],
      ),
    ]);
    expect(merged.facts.map((f) => f.object).sort()).toEqual(['Dune', 'The Hobbit']);
  });

  it('omits self-consistency stats unless asked', () => {
    const merged = mergeExtractions([
      pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
      pass([['Tim', 'customer']], [[0, 'lives_in', 'Dublin']]),
    ]);
    expect(merged.facts[0]!.extractionAgreement).toBeUndefined();
    expect(merged.facts[0]!.extractionEntropy).toBeUndefined();
  });

  it('emits self-consistency stats when asked (multi-pass re-rolls)', () => {
    const merged = mergeExtractions(
      [
        pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
        pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
      ],
      { selfConsistency: true },
    );
    expect(merged.facts[0]!.extractionAgreement).toBe(1);
  });

  it('handles a pass that produced nothing', () => {
    const merged = mergeExtractions([
      pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
      pass([], []),
    ]);
    expect(merged.facts).toHaveLength(1);
    expect(merged.entities).toHaveLength(1);
  });
});
