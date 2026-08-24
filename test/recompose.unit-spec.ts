import { RecomposeService } from '../src/compaction/recompose.service';

/**
 * Cascade recompose, Phase 1 (docs/roadmap/cascade-recompose-2026-07.md).
 *
 * The bug: `fn::resolve_fact` never touches `derivedFrom`, so a compaction
 * summary keeps serving a value its parent has already corrected. The only
 * cascade in the system fires from the explicit retract API alone, and it
 * DELETES rather than re-derives — which loses knowledge, because compaction
 * hides its sources and the summary is their only carrier.
 *
 * So this suite pins the two rules that make the fix correct rather than merely
 * present: 'compacted' must NOT invalidate (it is what compaction does to its
 * own sources), and a changed parent must lead to RECOMPUTE, with retraction
 * reserved for the one case where nothing survives.
 */
describe('RecomposeService', () => {
  type Q = { sql: string; params: any };

  function make(opts: {
    changes?: any[];
    cursor?: number;
    stale?: any[];
    parents?: Record<string, any>;
    summaryText?: string;
  }) {
    const queries: Q[] = [];
    const parents = opts.parents ?? {};
    const db = {
      query: async (sql: string, params: any) => {
        queries.push({ sql, params });
        if (sql.includes('FROM changefeed_state')) {
          return [[{ lastVersionstamp: opts.cursor ?? 0 }]];
        }
        if (sql.includes('SHOW CHANGES')) return [opts.changes ?? []];
        if (sql.includes('fn::mark_derived_stale')) {
          return [['knowledge_fact:sum1']];
        }
        if (sql.includes("source.kind = 'compaction-summary'")) {
          return [opts.stale ?? []];
        }
        if (sql.includes('WHERE id INSIDE $ids')) {
          const ids = (params.ids ?? []).map((i: any) => String(i));
          return [ids.map((i: string) => parents[i]).filter(Boolean)];
        }
        if (sql.includes('WHERE id = $id')) {
          return [[parents[String(params.id)]].filter(Boolean)];
        }
        return [null];
      },
    };
    const surreal = {
      withCompany: (_c: string, fn: (db: unknown) => Promise<unknown>) => fn(db),
    };
    const apiKeys = { knownCompanyIds: () => ['co_x'] };
    const generator = {
      generate: jest.fn(async (_group: any[]) => opts.summaryText ?? 'regenerated summary'),
    };
    const svc = new RecomposeService(surreal as never, apiKeys as never, generator as never);
    return { svc, queries, generator };
  }

  const change = (versionstamp: number, id: string, status: string) => ({
    versionstamp,
    changes: [{ update: { id, status } }],
  });

  const parent = (id: string, object: string, extra: any = {}) => ({
    id,
    predicate: 'lives_in',
    object,
    confidence: 0.9,
    validFrom: '2023-01-01T00:00:00Z',
    retractedAt: null,
    supersededBy: null,
    ...extra,
  });

  describe('invalidation', () => {
    it('marks descendants stale when a parent is superseded', async () => {
      const { svc, queries } = make({
        cursor: 10,
        changes: [change(11, 'knowledge_fact:p1', 'superseded')],
      });
      const marked = await svc.invalidate('co_x');
      expect(marked).toBe(1);
      const call = queries.find((q) => q.sql.includes('fn::mark_derived_stale'));
      expect(call!.params.parents.map(String)).toEqual(['knowledge_fact:p1']);
      expect(call!.params.reason).toBe('parent_changed');
    });

    it('marks descendants stale when a parent is retracted', async () => {
      const { svc, queries } = make({
        cursor: 10,
        changes: [change(11, 'knowledge_fact:p1', 'retracted')],
      });
      await svc.invalidate('co_x');
      expect(queries.some((q) => q.sql.includes('fn::mark_derived_stale'))).toBe(true);
    });

    it("does NOT treat 'compacted' as a change — that is compaction's own bookkeeping", async () => {
      // Compaction sets its sources to 'compacted' in the same pass that
      // creates the summary from them; invalidating on it would mark every
      // summary stale the instant it was born.
      const { svc, queries } = make({
        cursor: 10,
        changes: [change(11, 'knowledge_fact:p1', 'compacted')],
      });
      const marked = await svc.invalidate('co_x');
      expect(marked).toBe(0);
      expect(queries.some((q) => q.sql.includes('fn::mark_derived_stale'))).toBe(false);
    });

    it('ignores an ordinary active write', async () => {
      const { svc } = make({
        cursor: 10,
        changes: [change(11, 'knowledge_fact:p1', 'active')],
      });
      expect(await svc.invalidate('co_x')).toBe(0);
    });

    it('advances the cursor even when nothing needed marking', async () => {
      const { svc, queries } = make({
        cursor: 10,
        changes: [change(14, 'knowledge_fact:p1', 'active')],
      });
      await svc.invalidate('co_x');
      const upsert = queries.find((q) => q.sql.includes('UPSERT changefeed_state'));
      expect(upsert!.params.v).toBe(14);
    });

    it('skips changes at or below the cursor (SINCE is inclusive)', async () => {
      const { svc, queries } = make({
        cursor: 10,
        changes: [change(10, 'knowledge_fact:old', 'superseded')],
      });
      expect(await svc.invalidate('co_x')).toBe(0);
      expect(queries.some((q) => q.sql.includes('fn::mark_derived_stale'))).toBe(false);
    });
  });

  describe('recompute', () => {
    const staleSummary = {
      id: 'knowledge_fact:sum1',
      predicate: 'summary_lives_in',
      derivedFrom: ['knowledge_fact:p1', 'knowledge_fact:p2'],
      staleAt: '2023-06-01T00:00:00Z',
    };

    it('re-derives the summary and clears the stale mark', async () => {
      const { svc, queries, generator } = make({
        stale: [staleSummary],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin'),
          'knowledge_fact:p2': parent('knowledge_fact:p2', 'Dublin'),
        },
      });
      const out = await svc.recompute('co_x');
      expect(out).toEqual({ recomputed: 1, retracted: 0 });
      expect(generator.generate).toHaveBeenCalledTimes(1);
      const write = queries.find((q) => q.sql.includes('staleAt = NONE'));
      expect(write!.params.object).toBe('regenerated summary');
    });

    it('follows supersededBy so the summary reflects the CORRECTED value', async () => {
      const { svc, generator } = make({
        stale: [{ ...staleSummary, derivedFrom: ['knowledge_fact:p1'] }],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'a vague description', {
            supersededBy: 'knowledge_fact:p1v2',
          }),
          'knowledge_fact:p1v2': parent('knowledge_fact:p1v2', 'Under Armour'),
        },
      });
      await svc.recompute('co_x');
      const group = generator.generate.mock.calls[0]![0] as any[];
      expect(group.map((g) => g.object)).toEqual(['Under Armour']);
    });

    it('re-points derivedFrom at the current parents, not the dead rows', async () => {
      const { svc, queries } = make({
        stale: [{ ...staleSummary, derivedFrom: ['knowledge_fact:p1'] }],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'old', {
            supersededBy: 'knowledge_fact:p1v2',
          }),
          'knowledge_fact:p1v2': parent('knowledge_fact:p1v2', 'new'),
        },
      });
      await svc.recompute('co_x');
      const write = queries.find((q) => q.sql.includes('staleAt = NONE'));
      expect(write!.params.derivedFrom.map(String)).toEqual(['knowledge_fact:p1v2']);
    });

    it('drops a retracted parent but keeps the summary over the survivors', async () => {
      const { svc, generator } = make({
        stale: [staleSummary],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin', {
            retractedAt: '2023-05-01T00:00:00Z',
          }),
          'knowledge_fact:p2': parent('knowledge_fact:p2', 'Dublin'),
        },
      });
      const out = await svc.recompute('co_x');
      expect(out.recomputed).toBe(1);
      const group = generator.generate.mock.calls[0]![0] as any[];
      expect(group.map((g) => g.object)).toEqual(['Dublin']);
    });

    it('retracts the summary ONLY when no parent survives', async () => {
      const { svc, queries } = make({
        stale: [staleSummary],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin', {
            retractedAt: '2023-05-01T00:00:00Z',
          }),
          'knowledge_fact:p2': parent('knowledge_fact:p2', 'Dublin', {
            retractedAt: '2023-05-02T00:00:00Z',
          }),
        },
      });
      const out = await svc.recompute('co_x');
      expect(out).toEqual({ recomputed: 0, retracted: 1 });
      const retract = queries.find((q) => q.sql.includes("status = 'retracted'"));
      expect(retract!.sql).toContain('all parents retracted');
    });

    it('feeds the generator a chronologically sorted group', async () => {
      const { svc, generator } = make({
        stale: [staleSummary],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'later', {
            validFrom: '2023-09-01T00:00:00Z',
          }),
          'knowledge_fact:p2': parent('knowledge_fact:p2', 'earlier', {
            validFrom: '2023-02-01T00:00:00Z',
          }),
        },
      });
      await svc.recompute('co_x');
      const group = generator.generate.mock.calls[0]![0] as any[];
      expect(group.map((g) => g.object)).toEqual(['earlier', 'later']);
    });

    it('leaves the summary stale when the generator returns nothing', async () => {
      const { svc, queries } = make({
        stale: [staleSummary],
        parents: { 'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin') },
        summaryText: '',
      });
      const out = await svc.recompute('co_x');
      expect(out.recomputed).toBe(0);
      // Better to retry next pass than to clear the mark on a failed rewrite.
      expect(queries.some((q) => q.sql.includes('staleAt = NONE'))).toBe(false);
    });

    it('is a no-op when nothing is stale', async () => {
      const { svc, generator } = make({ stale: [] });
      expect(await svc.recompute('co_x')).toEqual({
        recomputed: 0,
        retracted: 0,
      });
      expect(generator.generate).not.toHaveBeenCalled();
    });
  });
});
