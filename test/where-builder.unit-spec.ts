import { buildBaseWhere } from '../src/search/internals/where-builder';
import type { SearchDto } from '../src/search/dto/search.dto';

const dto = (extra: Partial<SearchDto> = {}): SearchDto => ({ query: 'x', ...extra }) as SearchDto;

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
    expect(sql).toContain("(status != 'superseded' OR validUntil > time::now())");
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
    expect(sql).not.toContain('validUntil > time::now()');
  });
});

describe('buildBaseWhere — the fences every leg shares', () => {
  const saved = { tags: process.env.SCOPE_TAGS_ENABLED };
  afterEach(() => {
    if (saved.tags === undefined) delete process.env.SCOPE_TAGS_ENABLED;
    else process.env.SCOPE_TAGS_ENABLED = saved.tags;
  });
  const base = (extra: Partial<Parameters<typeof buildBaseWhere>[0]> = {}) =>
    buildBaseWhere({
      dto: dto(),
      asOf: null,
      includeRetracted: false,
      includeContested: false,
      ...extra,
    });

  it('emits only AND-fragments, so any leg can splice it after its own WHERE', () => {
    process.env.SCOPE_TAGS_ENABLED = '1';
    const { sql } = base({ dto: dto({ userId: 'u1', minConfidence: 0.5, predicates: ['p'] }) });
    const lines = sql
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.startsWith('AND ')).toBe(true);
  });

  it('without a userId the read is tenant-global only — no personal row, no user param', () => {
    const { sql, params } = base();
    expect(sql).toContain('AND userId IS NONE');
    expect(sql).not.toContain('$scopeUserId');
    expect(params).not.toHaveProperty('scopeUserId');
  });

  it('with a userId the read is tenant-global plus that user, bound by parameter', () => {
    const { sql, params } = base({ dto: dto({ userId: 'u1' }) });
    expect(sql).toContain('AND (userId IS NONE OR userId = $scopeUserId)');
    expect(sql).not.toContain('AND userId IS NONE\n');
    expect(params.scopeUserId).toBe('u1');
  });

  it('the scope-tag fence is appended for a user when on, and absent when off', () => {
    process.env.SCOPE_TAGS_ENABLED = '1';
    const on = base({ dto: dto({ userId: 'u1' }) });
    expect(on.sql).toMatch(/AND \(scope = \[\] OR scope (=|ALLINSIDE)/);
    expect(Object.keys(on.params)).toContain('principalScopeTag');
    process.env.SCOPE_TAGS_ENABLED = '0';
    const off = base({ dto: dto({ userId: 'u1' }) });
    expect(off.sql).not.toContain('scope =');
    expect(off.params).not.toHaveProperty('principalScopeTag');
  });

  it('retracted and contested rows are fenced unless the caller asks for them', () => {
    const closed = base();
    expect(closed.sql).toContain('AND retractedAt IS NONE');
    expect(closed.sql).toContain("AND status != 'competing'");
    const open = base({ includeRetracted: true, includeContested: true });
    expect(open.sql).not.toContain('AND retractedAt IS NONE');
    expect(open.sql).not.toContain("AND status != 'competing'");
  });

  it('confidence, predicate and entity filters apply only when given, with bound values', () => {
    const none = base({ dto: dto({ predicates: [], entityIds: [] }) });
    expect(none.sql).not.toMatch(/confidence >=|predicate INSIDE|entityId INSIDE/);
    expect(none.params).not.toHaveProperty('predicates');
    expect(none.params).not.toHaveProperty('entityIds');
    const some = base({
      dto: dto({
        minConfidence: 0,
        predicates: ['works_at'],
        entityIds: ['abc', 'knowledge_entity:def'],
      }),
    });
    expect(some.sql).toContain('AND confidence >= $minConfidence');
    expect(some.params.minConfidence).toBe(0);
    expect(some.sql).toContain('AND predicate INSIDE $predicates');
    expect(some.params.predicates).toEqual(['works_at']);
    expect(some.sql).toContain('AND entityId INSIDE $entityIds');
    // Short and fully qualified ids address the same records.
    expect((some.params.entityIds as unknown[]).map(String)).toEqual([
      'knowledge_entity:abc',
      'knowledge_entity:def',
    ]);
  });

  it('the language filter is a hard filter only with a language, no opt-out and no soft boost', () => {
    const hard = base({ opts: { langFilter: 'en' } });
    expect(hard.sql).toContain('AND (lang = $langFilter OR lang IS NONE)');
    expect(hard.params.langFilter).toBe('en');
    expect(base().sql).not.toContain('$langFilter');
    expect(
      base({ dto: dto({ disableLangFilter: true }), opts: { langFilter: 'en' } }).sql,
    ).not.toContain('$langFilter');
    expect(base({ opts: { langFilter: 'en', langBoost: true } }).sql).not.toContain('$langFilter');
  });
});
