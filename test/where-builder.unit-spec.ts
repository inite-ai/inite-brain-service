import { buildBaseWhere } from '../src/search/internals/where-builder';
import type { SearchDto } from '../src/search/dto/search.dto';

const dto = (extra: Partial<SearchDto> = {}): SearchDto =>
  ({ query: 'x', ...extra }) as SearchDto;

describe('buildBaseWhere default-now bitemporal visibility', () => {
  it('admits a future-supersede prior whose interval still covers now', () => {
    const { sql } = buildBaseWhere(dto(), null, false, false);
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
    const { sql } = buildBaseWhere(dto({ asOf: '2026-01-01' }), new Date(), false, false);
    expect(sql).toContain('validFrom <= $asOf');
    expect(sql).toContain("status != 'compacted'");
    expect(sql).not.toContain("status != 'superseded'");
  });

  it('includeStale drops the temporal closure entirely', () => {
    const { sql } = buildBaseWhere(dto({ includeStale: true }), null, false, false);
    expect(sql).not.toContain("validUntil > time::now()");
  });
});
