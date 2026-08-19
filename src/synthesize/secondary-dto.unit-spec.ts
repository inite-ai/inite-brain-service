import { buildSecondaryDto } from './synthesize.helpers';
import type { SearchDto } from '../search/dto/search.dto';

describe('buildSecondaryDto (audit 2026-08-19 P1 — filter inheritance)', () => {
  const base = {
    query: 'original question',
    limit: 10,
    asOf: '2023-05-07T00:00:00.000Z',
    userId: 'user-7',
    entityIds: ['entity:a'],
    entityTypes: ['person'],
    predicates: ['events'],
    minConfidence: 0.4,
    includeContested: false,
    includeRetracted: true,
    requireProvenance: true,
    searchMode: 'lexical',
  } as unknown as SearchDto;

  it('inherits the full caller filter contract, overrides only query/limit', () => {
    const dto = buildSecondaryDto(base, { query: 'refined', limit: 8 });
    expect(dto.query).toBe('refined');
    expect(dto.limit).toBe(8);
    expect(dto.userId).toBe('user-7');
    expect(dto.asOf).toBe(base.asOf);
    expect(dto.entityIds).toEqual(['entity:a']);
    expect(dto.entityTypes).toEqual(['person']);
    expect(dto.predicates).toEqual(['events']);
    expect(dto.minConfidence).toBe(0.4);
    expect(dto.includeContested).toBe(false);
    expect(dto.includeRetracted).toBe(true);
    expect(dto.requireProvenance).toBe(true);
    expect(dto.searchMode).toBe('lexical');
  });

  it('omits absent fields instead of stamping undefined', () => {
    const dto = buildSecondaryDto({ query: 'q' } as SearchDto, {
      query: 'probe',
    });
    expect(Object.keys(dto).sort()).toEqual(['limit', 'query']);
    expect(dto.limit).toBe(10);
  });
});
