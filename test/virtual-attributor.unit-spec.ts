/**
 * Unit-test for virtual composition attribution — union-extracted facts
 * split per owning pack by predicate namespace (packId__localId), core
 * predicates → 'core'.
 */
import {
  attributeFactsByIndexer,
  indexerIdOfPredicate,
} from '../src/indexers/virtual-attributor';
import type { ExtractedFact } from '../src/ai/extractor-internals/types';

const fact = (predicate: string, entityIndex = 0): ExtractedFact => ({
  entityIndex,
  predicate,
  object: 'x',
  confidence: 0.8,
});

describe('indexerIdOfPredicate', () => {
  it('pack-namespaced predicate → pack id', () => {
    expect(indexerIdOfPredicate('real_estate__zoned_as')).toBe('real_estate');
    expect(indexerIdOfPredicate('code_memory__decided')).toBe('code_memory');
  });

  it('core predicate → core', () => {
    expect(indexerIdOfPredicate('works_at')).toBe('core');
    expect(indexerIdOfPredicate('prefers')).toBe('core');
  });

  it('leading separator does not attribute to an empty pack', () => {
    expect(indexerIdOfPredicate('__weird')).toBe('core');
  });

  it('nested separators attribute to the first segment', () => {
    expect(indexerIdOfPredicate('a__b__c')).toBe('a');
  });
});

describe('attributeFactsByIndexer', () => {
  it('groups facts per pack, preserving order', () => {
    const facts = [
      fact('works_at'),
      fact('real_estate__zoned_as'),
      fact('real_estate__valued_at'),
      fact('fintech__regulated_by'),
      fact('lives_in'),
    ];
    const grouped = attributeFactsByIndexer(facts);
    expect([...grouped.keys()].sort()).toEqual(['core', 'fintech', 'real_estate']);
    expect(grouped.get('core')!.map((f) => f.predicate)).toEqual([
      'works_at',
      'lives_in',
    ]);
    expect(grouped.get('real_estate')!.map((f) => f.predicate)).toEqual([
      'real_estate__zoned_as',
      'real_estate__valued_at',
    ]);
  });

  it('empty input → empty map', () => {
    expect(attributeFactsByIndexer([]).size).toBe(0);
  });
});
