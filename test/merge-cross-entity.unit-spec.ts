import { mergeExtractions } from '../src/ai/extractor-internals/merge';
import { clusterKey } from '../src/ai/extractor-internals/semantic-entropy';
import type { ExtractionResult } from '../src/ai/extractor-internals/types';

/**
 * Audit W3 #5 (engine-architecture-audit-2026-08.md): the merge deduped
 * facts on (predicate, object) with a GLOBAL seen-set, ignoring which
 * entity the fact was about. Two people sharing a value collided and one
 * fact was silently dropped.
 */
function pass(
  entities: Array<{ name: string; type: string }>,
  facts: Array<{ entityIndex: number; predicate: string; object: string }>,
): ExtractionResult {
  return {
    entities: entities as ExtractionResult['entities'],
    facts: facts.map((f) => ({ ...f, confidence: 0.9 })),
    edges: [],
  };
}

describe('merge keeps same-value facts of different entities (W3 #5)', () => {
  it('two people living in Berlin both survive', () => {
    const merged = mergeExtractions([
      pass(
        [
          { name: 'Anna', type: 'customer' },
          { name: 'Boris', type: 'customer' },
        ],
        [
          { entityIndex: 0, predicate: 'address', object: 'Berlin' },
          { entityIndex: 1, predicate: 'address', object: 'Berlin' },
        ],
      ),
    ]);
    expect(merged.facts).toHaveLength(2);
    expect(new Set(merged.facts.map((f) => f.entityIndex))).toEqual(new Set([0, 1]));
  });

  it('the SAME entity+value across passes still dedupes to one', () => {
    const merged = mergeExtractions([
      pass(
        [{ name: 'Anna', type: 'customer' }],
        [{ entityIndex: 0, predicate: 'address', object: 'Berlin' }],
      ),
      pass(
        [{ name: 'Anna', type: 'customer' }],
        [{ entityIndex: 0, predicate: 'address', object: 'berlin ' }],
      ),
    ]);
    expect(merged.facts).toHaveLength(1);
  });

  it('clusterKey separates entities and still normalises the object', () => {
    expect(clusterKey({ predicate: 'p', object: 'Berlin', entity: 0 })).not.toBe(
      clusterKey({ predicate: 'p', object: 'Berlin', entity: 1 }),
    );
    expect(clusterKey({ predicate: 'p', object: ' Berlin ', entity: 0 })).toBe(
      clusterKey({ predicate: 'p', object: 'berlin', entity: 0 }),
    );
  });
});
