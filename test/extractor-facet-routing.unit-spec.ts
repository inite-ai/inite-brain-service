import {
  detectFacets,
  hasEnumeration,
  hasNamedEntity,
} from '../src/ai/extractor-internals/facet-router';
import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import { buildFacetSystemPrompt } from '../src/ai/extractor-internals/prompts';
import type { ExtractionResult } from '../src/ai/extractor-internals/types';

/**
 * Facet routing (EXTRACTOR_ROUTING_ENABLED) — specialist extraction passes for
 * the two contracts the single generalist prompt measurably drops: list items
 * ("What books has Tim read?" came back partial) and proper names ("Under
 * Armour" came back as "a renowned outdoor gear company").
 *
 * The router is a LOCAL heuristic biased toward NOT firing — a missed facet
 * costs the general pass's output, a facet firing on every turn triples ingest
 * cost for nothing.
 */
describe('facet router', () => {
  describe('enumeration detection', () => {
    it('fires on a three-item list, the shape that loses items', () => {
      expect(hasEnumeration('we do pottery, camping, and painting')).toBe(true);
      expect(
        hasEnumeration("I've read The Hobbit, Dune and most of Discworld"),
      ).toBe(true);
    });

    it('does not fire on two items — those already survive', () => {
      expect(hasEnumeration('I went to Rome and Paris')).toBe(false);
    });

    it('does not fire on comma-spliced conversational filler', () => {
      expect(hasEnumeration('Well, yes, ok')).toBe(false);
      expect(hasEnumeration('That is great!')).toBe(false);
    });
  });

  describe('named-entity detection', () => {
    it('fires on a proper noun anywhere past the sentence opener', () => {
      expect(hasNamedEntity('I think Sarah left already')).toBe(true);
      expect(hasNamedEntity('he signed with Under Armour')).toBe(true);
    });

    it('does not fire on a sentence-initial capital alone', () => {
      expect(hasNamedEntity('Yesterday was rough.')).toBe(false);
      expect(hasNamedEntity('Nothing much happened.')).toBe(false);
    });

    it('does not treat the first-person "I" as a name', () => {
      expect(hasNamedEntity('honestly I am tired')).toBe(false);
    });
  });

  it('returns no facets for an ordinary turn (single pass, byte-identical)', () => {
    expect(detectFacets('yeah, that sounds nice')).toEqual([]);
  });

  it('can return both facets for a turn that has both shapes', () => {
    expect(
      detectFacets('I read The Hobbit, Dune, and Discworld last year'),
    ).toEqual(['enumeration', 'entity']);
  });

  describe('facet prompts', () => {
    it('narrows the enumeration pass to one contract', () => {
      const p = buildFacetSystemPrompt('enumeration');
      expect(p).toContain('LIST ITEMS ONLY');
      expect(p).toContain('ONE FACT PER ITEM');
    });

    it('forbids the entity pass from substituting a description for a name', () => {
      const p = buildFacetSystemPrompt('entity');
      expect(p).toContain('NAMED THINGS ONLY');
      expect(p).toContain('Under Armour');
    });

    it('degrades an unknown facet to the plain dialogue prompt', () => {
      expect(buildFacetSystemPrompt('nonsense')).toBe(
        buildFacetSystemPrompt('nonsense'),
      );
      expect(buildFacetSystemPrompt('nonsense')).not.toContain('THIS PASS');
    });
  });
});

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
    expect(merged.entities[adopted!.entityIndex].name).toBe('Caroline');
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
    expect(merged.entities[merged.edges[0].fromEntityIndex].name).toBe('Melanie');
    expect(merged.entities[merged.edges[0].toEntityIndex].name).toBe('Acme');
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
    expect(merged.facts.map((f) => f.object).sort()).toEqual([
      'Dune',
      'The Hobbit',
    ]);
  });

  it('omits self-consistency stats across facets — different jobs, not re-rolls', () => {
    const merged = mergeExtractions([
      pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
      pass([['Tim', 'customer']], [[0, 'lives_in', 'Dublin']]),
    ]);
    expect(merged.facts[0].extractionAgreement).toBeUndefined();
    expect(merged.facts[0].extractionEntropy).toBeUndefined();
  });

  it('emits self-consistency stats when asked (multi-pass re-rolls)', () => {
    const merged = mergeExtractions(
      [
        pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
        pass([['Tim', 'customer']], [[0, 'read', 'Dune']]),
      ],
      { selfConsistency: true },
    );
    expect(merged.facts[0].extractionAgreement).toBe(1);
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
