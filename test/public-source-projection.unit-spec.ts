/**
 * Pure-projection tests for the public /v1/sources surface (trust-inputs
 * track): the owner/note redaction, the 50-row history cap, the filter
 * matrix (type / minSamples / domain capture), and pagination.
 */
import {
  filterAndPage,
  PUBLIC_HISTORY_LIMIT,
  PUBLIC_LIST_MAX_LIMIT,
  toPublicDeclared,
  toPublicDetail,
  toPublicSummary,
} from '../src/sources/public-projection';
import type {
  DeclaredSource,
  SourceSummary,
  TrustScopeRow,
} from '../src/contracts/sources/sources.schema';

const declared = (over: Partial<DeclaredSource> = {}): DeclaredSource => ({
  sourceKey: 'rent:senior_auditor',
  type: 'human',
  authLevel: 0.8,
  owner: 'ops@inite.ai',
  note: 'internal-only annotation',
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  ...over,
});

const trust = (over: Partial<TrustScopeRow> = {}): TrustScopeRow => ({
  domain: null,
  agreementRate: 0.9,
  sampleCount: 12,
  winCount: 11,
  lossCount: 1,
  lastSeenAt: '2026-07-08T00:00:00.000Z',
  ...over,
});

const summary = (over: Partial<SourceSummary> = {}): SourceSummary => ({
  sourceKey: 'rent:a',
  declared: null,
  globalTrust: null,
  scopedDomains: 0,
  ...over,
});

describe('toPublicDeclared', () => {
  it('keeps ONLY type + authLevel — owner/note/timestamps are dropped', () => {
    const out = toPublicDeclared(declared());
    expect(out).toEqual({ type: 'human', authLevel: 0.8 });
    expect(Object.keys(out as object).sort()).toEqual(['authLevel', 'type']);
  });

  it('passes null through', () => {
    expect(toPublicDeclared(null)).toBeNull();
  });
});

describe('toPublicSummary', () => {
  it('projects declared and omits domainTrust when no domain was asked', () => {
    const out = toPublicSummary(
      summary({ declared: declared(), globalTrust: trust(), scopedDomains: 2 }),
      false,
    );
    expect(out).toEqual({
      sourceKey: 'rent:a',
      declared: { type: 'human', authLevel: 0.8 },
      globalTrust: trust(),
      scopedDomains: 2,
    });
    expect('domainTrust' in out).toBe(false);
  });

  it('materializes domainTrust (null when the source lacks the domain row)', () => {
    const withRow = toPublicSummary(
      summary({ domainTrust: trust({ domain: 'status' }) }),
      true,
    );
    expect(withRow.domainTrust).toEqual(trust({ domain: 'status' }));
    const withoutRow = toPublicSummary(summary(), true);
    expect(withoutRow.domainTrust).toBeNull();
  });
});

describe('toPublicDetail', () => {
  it('drops owner/note and slices history to the 50 newest rows', () => {
    const history = Array.from({ length: 80 }, (_, i) => ({
      domain: null,
      agreementRate: 0.5,
      sampleCount: 80 - i,
      // Newest-first, as the service serves it.
      recordedAt: new Date(Date.UTC(2026, 0, 80 - i)).toISOString(),
    }));
    const out = toPublicDetail({
      sourceKey: 'rent:a',
      declared: declared(),
      trust: [trust(), trust({ domain: 'status' })],
      history,
    });
    expect(out.declared).toEqual({ type: 'human', authLevel: 0.8 });
    expect(out.history).toHaveLength(PUBLIC_HISTORY_LIMIT);
    // The kept rows are the FIRST 50 — i.e. the newest.
    expect(out.history[0]).toEqual(history[0]);
    expect(out.history[49]).toEqual(history[49]);
    expect(JSON.stringify(out)).not.toContain('ops@inite.ai');
    expect(JSON.stringify(out)).not.toContain('internal-only annotation');
  });
});

describe('filterAndPage', () => {
  const page = { limit: 50, offset: 0 };
  const corpus: SourceSummary[] = [
    summary({
      sourceKey: 'rent:human_big',
      declared: declared({ type: 'human' }),
      globalTrust: trust({ sampleCount: 40 }),
      scopedDomains: 1,
      domainTrust: trust({ domain: 'status', sampleCount: 3 }),
    }),
    summary({
      sourceKey: 'rent:api_small',
      declared: declared({ type: 'api' }),
      globalTrust: trust({ sampleCount: 5 }),
    }),
    summary({ sourceKey: 'rent:undeclared', globalTrust: null }),
  ];

  it('sorts by sourceKey and reports total', () => {
    const { items, total } = filterAndPage(corpus, page);
    expect(total).toBe(3);
    expect(items.map((s) => s.sourceKey)).toEqual([
      'rent:api_small',
      'rent:human_big',
      'rent:undeclared',
    ]);
  });

  it('type filter matches the DECLARED type (undeclared never matches)', () => {
    const { items, total } = filterAndPage(corpus, { ...page, type: 'human' });
    expect(total).toBe(1);
    expect(items[0]!.sourceKey).toBe('rent:human_big');
  });

  it('minSamples judges the global row when no domain is active', () => {
    const { items } = filterAndPage(corpus, { ...page, minSamples: 10 });
    expect(items.map((s) => s.sourceKey)).toEqual(['rent:human_big']);
    // Missing globalTrust counts as 0 samples.
    const all = filterAndPage(corpus, { ...page, minSamples: 0 });
    expect(all.total).toBe(3);
  });

  it('minSamples judges domainTrust ?? globalTrust when domain is active', () => {
    // human_big has 40 global samples but only 3 in `status` — the scoped
    // row wins the comparison and knocks it out.
    const scoped = filterAndPage(corpus, {
      ...page,
      domain: 'status',
      minSamples: 10,
    });
    expect(scoped.items.map((s) => s.sourceKey)).toEqual([]);
    // api_small has NO status row — falls back to its 5 global samples.
    const fallback = filterAndPage(corpus, {
      ...page,
      domain: 'status',
      minSamples: 4,
    });
    expect(fallback.items.map((s) => s.sourceKey)).toEqual(['rent:api_small']);
  });

  it('captures domainTrust on every item iff domain is active', () => {
    const { items } = filterAndPage(corpus, { ...page, domain: 'status' });
    const byKey = new Map(items.map((s) => [s.sourceKey, s]));
    expect(byKey.get('rent:human_big')?.domainTrust).toEqual(
      trust({ domain: 'status', sampleCount: 3 }),
    );
    expect(byKey.get('rent:api_small')?.domainTrust).toBeNull();
    const plain = filterAndPage(corpus, page);
    expect(plain.items.every((s) => !('domainTrust' in s))).toBe(true);
  });

  it('pages: limit above the cap is clamped; offset beyond the end is empty with correct total', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      summary({ sourceKey: `rent:s${String(i).padStart(3, '0')}` }),
    );
    const capped = filterAndPage(many, { limit: 10_000, offset: 0 });
    expect(capped.items).toHaveLength(PUBLIC_LIST_MAX_LIMIT);
    expect(capped.total).toBe(250);

    const beyond = filterAndPage(many, { limit: 50, offset: 9_999 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(250);

    const window = filterAndPage(many, { limit: 2, offset: 1 });
    expect(window.items.map((s) => s.sourceKey)).toEqual([
      'rent:s001',
      'rent:s002',
    ]);
  });
});
