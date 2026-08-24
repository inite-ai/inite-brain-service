import { EntitiesService } from '../src/entities/entities.service';
import type { BrainScope } from '../src/auth/api-key.types';

/**
 * GET /v1/entities/autocomplete — entity-name typeahead over the edge-ngram
 * `prefix` fulltext index (migration 0070). Unit-level: verifies the
 * short-circuit for sub-min queries, the limit clamp, the query shape
 * (prefix matcher + live/tenant-global fences + BM25 ordering), and row
 * mapping. The index behaviour itself is prototyped against a live DB.
 */
describe('EntitiesService.autocomplete', () => {
  type Captured = { sql: string; params: Record<string, unknown> };

  function make(rows: unknown[] = []) {
    const captured: Captured[] = [];
    const db = {
      query: async (sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        return [rows];
      },
    };
    const withScopedCompany = jest.fn(
      async (_companyId: string, _scopes: BrainScope[], fn: (db: unknown) => Promise<unknown>) =>
        fn(db),
    );
    const surreal = { withScopedCompany } as never;
    const svc = new EntitiesService(
      surreal,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return { svc, captured, withScopedCompany };
  }

  const scopes: BrainScope[] = ['brain:read'];

  it('short-circuits a sub-minimum query without touching the DB', async () => {
    const { svc, withScopedCompany } = make();
    for (const q of ['', ' ', 'a', ' x ']) {
      const out = await svc.autocomplete({ companyId: 'co_x', q, scopes });
      expect(out).toEqual({ suggestions: [] });
    }
    expect(withScopedCompany).not.toHaveBeenCalled();
  });

  it('lowercases + trims the term and issues the prefix-matcher query', async () => {
    const { svc, captured } = make([
      { id: 'knowledge_entity:1', type: 'person', canonicalName: 'Caroline', score: 0.9 },
      { id: 'knowledge_entity:2', type: 'person', canonicalName: 'Carlos', score: 0.7 },
    ]);
    const out = await svc.autocomplete({ companyId: 'co_x', q: '  Car ', scopes });
    expect(out.suggestions).toEqual([
      { entityId: 'knowledge_entity:1', canonicalName: 'Caroline', type: 'person', score: 0.9 },
      { entityId: 'knowledge_entity:2', canonicalName: 'Carlos', type: 'person', score: 0.7 },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.params.q).toBe('car');
    const sql = captured[0]!.sql;
    expect(sql).toContain('canonicalNameLc @1@ $q');
    expect(sql).toContain('mergedInto IS NONE');
    expect(sql).toContain('userId IS NONE');
    expect(sql).toContain('search::score(1)');
    expect(sql).toContain('ORDER BY score DESC');
  });

  it('clamps the limit to [1, 25] and defaults to 10', async () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, 10],
      [0, 1],
      [-5, 1],
      [100, 25],
      [12, 12],
      [12.9, 12], // truncated, not rounded
    ];
    for (const [input, expected] of cases) {
      const { svc, captured } = make();
      await svc.autocomplete({ companyId: 'co_x', q: 'car', limit: input, scopes });
      expect(captured[0]!.params.lim).toBe(expected);
    }
  });

  it('returns empty suggestions when the DB yields no rows', async () => {
    const { svc } = make([]);
    const out = await svc.autocomplete({ companyId: 'co_x', q: 'zzz', scopes });
    expect(out).toEqual({ suggestions: [] });
  });
});
