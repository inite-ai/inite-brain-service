/**
 * Unit coverage for the filter-mode narrowing decision
 * (SEARCH_DOMAIN_ROUTING_MODE=filter). The pure helper decides whether
 * the retrieval legs narrow to a predicate allow-list; the pipeline then
 * applies it ONLY to legsWhere, leaving baseWhere (edge expansion +
 * backfill) un-narrowed.
 */
import { SearchService } from '../src/search/search.service';
import type { DomainSignal } from '../src/ai/domain-routing.service';

const withNarrow = (narrowTo: string[] | null): DomainSignal =>
  ({
    version: 'v1',
    vocab: { entries: [], version: 'v1' },
    affinities: [],
    matched: [],
    boost: null,
    narrowTo,
  }) as DomainSignal;

describe('SearchService.resolveDomainNarrowing', () => {
  const resolve = SearchService.resolveDomainNarrowing;

  it('boost mode never narrows, even with a matched signal', () => {
    expect(
      resolve('boost', withNarrow(['name', 'persona__life_event'])),
    ).toBeUndefined();
  });

  it('filter mode with no signal → no narrowing', () => {
    expect(resolve('filter', null)).toBeUndefined();
    expect(resolve('filter', undefined)).toBeUndefined();
  });

  it('filter mode with an unmatched signal (narrowTo null) → no narrowing', () => {
    expect(resolve('filter', withNarrow(null))).toBeUndefined();
  });

  it('filter mode with a matched signal narrows to core ∪ domain', () => {
    expect(
      resolve('filter', withNarrow(['name', 'status', 'persona__felt'])),
    ).toEqual(['name', 'status', 'persona__felt']);
  });
});
