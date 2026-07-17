import { buildBaseWhere } from '../src/search/internals/where-builder';
import type { SearchDto } from '../src/search/dto/search.dto';

const dto = (extra: Partial<SearchDto> = {}): SearchDto =>
  ({ query: 'x', ...extra }) as SearchDto;

describe('buildBaseWhere default-now bitemporal visibility', () => {
  it('admits a future-supersede prior whose interval still covers now', () => {
    const { sql } = buildBaseWhere({
      dto: dto(),
      asOf: null,
      includeRetracted: false,
      includeContested: false,
    });
    // The blanket superseded exclusion is gone…
    expect(sql).not.toContain("status NOT IN ['superseded', 'compacted']");
    // …replaced by a compacted exclusion plus a guarded superseded clause
    // so a superseded fact still visible-now (validUntil > now) survives.
    expect(sql).toContain("status != 'compacted'");
    expect(sql).toContain(
      "(status != 'superseded' OR validUntil > time::now())",
    );
  });

  it('asOf path is unchanged (validity-axis only, no status gap clause)', () => {
    const { sql } = buildBaseWhere({
      dto: dto({ asOf: '2026-01-01' }),
      asOf: new Date(),
      includeRetracted: false,
      includeContested: false,
    });
    expect(sql).toContain('validFrom <= $asOf');
    expect(sql).toContain("status != 'compacted'");
    expect(sql).not.toContain("status != 'superseded'");
  });

  it('includeStale drops the temporal closure entirely', () => {
    const { sql } = buildBaseWhere({
      dto: dto({ includeStale: true }),
      asOf: null,
      includeRetracted: false,
      includeContested: false,
    });
    expect(sql).not.toContain("validUntil > time::now()");
  });
});

describe('buildBaseWhere domain-routing filter (opts.domainPredicates)', () => {
  const base = () => ({
    asOf: null,
    includeRetracted: false,
    includeContested: false,
  });

  it('absent domainPredicates → no clause, byte-identical SQL', () => {
    const without = buildBaseWhere({ dto: dto(), ...base() });
    const withEmpty = buildBaseWhere({
      dto: dto(),
      ...base(),
      opts: { domainPredicates: [] },
    });
    expect(withEmpty.sql).toEqual(without.sql);
    expect(withEmpty.params).toEqual(without.params);
  });

  it('narrows on a distinct $domainPredicates param', () => {
    const { sql, params } = buildBaseWhere({
      dto: dto(),
      ...base(),
      opts: { domainPredicates: ['name', 'persona__life_event'] },
    });
    expect(sql).toContain('AND predicate INSIDE $domainPredicates');
    expect(params.domainPredicates).toEqual(['name', 'persona__life_event']);
  });

  it('composes with caller predicates on separate params', () => {
    const { sql, params } = buildBaseWhere({
      dto: dto({ predicates: ['status'] }),
      ...base(),
      opts: { domainPredicates: ['name', 'persona__felt'] },
    });
    // Both clauses present, each on its own bound param — they intersect.
    expect(sql).toContain('AND predicate INSIDE $predicates');
    expect(sql).toContain('AND predicate INSIDE $domainPredicates');
    expect(params.predicates).toEqual(['status']);
    expect(params.domainPredicates).toEqual(['name', 'persona__felt']);
  });
});
