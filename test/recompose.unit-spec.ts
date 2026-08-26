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

  /**
   * Evidence plane (PROVENANCE_SUMMARY_EPISODE_STAMP): the rewrite
   * re-stamps source.episodeIds from the CURRENT parents' union in the
   * same UPDATE — the incremental path that makes a backfill pass
   * unnecessary. Flag off must produce today's EXACT statement (golden
   * below); an empty union under the flag clears the field with NONE.
   */
  describe('rewrite — summary episode re-stamping', () => {
    const saved = process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
    afterEach(() => {
      if (saved === undefined) delete process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
      else process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = saved;
    });

    const staleSummary = {
      id: 'knowledge_fact:sum1',
      predicate: 'summary_lives_in',
      derivedFrom: ['knowledge_fact:p1', 'knowledge_fact:p2'],
      staleAt: '2023-06-01T00:00:00Z',
    };
    const stampedParents = {
      'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin', {
        eps: ['episode:e1', 'episode:shared'],
      }),
      'knowledge_fact:p2': parent('knowledge_fact:p2', 'Dublin', {
        validFrom: '2023-02-01T00:00:00Z',
        eps: ['episode:shared', 'episode:e2'],
      }),
    };

    it("flag OFF (default): today's EXACT statement — golden, no episodeIds fragment", async () => {
      delete process.env.PROVENANCE_SUMMARY_EPISODE_STAMP;
      const { svc, queries } = make({ stale: [staleSummary], parents: stampedParents });
      await svc.recompute('co_x');
      const write = queries.find((q) => q.sql.includes('staleAt = NONE'));
      expect(write!.sql).toBe(
        `UPDATE $id SET
         object = $object, confidence = $confidence,
         validFrom = <datetime>$validFrom,
         validUntil = <datetime>$validUntil,
         derivedFrom = $derivedFrom,
         staleAt = NONE, staleReason = NONE`,
      );
      expect(write!.params.episodeIds).toBeUndefined();
    });

    it('flag ON: re-stamps the union of the CURRENT parents (chronological parent order)', async () => {
      process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
      const { svc, queries } = make({ stale: [staleSummary], parents: stampedParents });
      await svc.recompute('co_x');
      const write = queries.find((q) => q.sql.includes('staleAt = NONE'));
      expect(write!.sql).toContain('source.episodeIds = $episodeIds');
      // Parents are fed chronologically (p1 2023-01 before p2 2023-02);
      // the union follows that order, 'shared' deduped on first sight.
      expect(write!.params.episodeIds).toEqual(['episode:e1', 'episode:shared', 'episode:e2']);
    });

    it('flag ON: follows supersededBy — the stamp comes from the LIVE parent', async () => {
      process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
      const { svc, queries } = make({
        stale: [{ ...staleSummary, derivedFrom: ['knowledge_fact:p1'] }],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'old', {
            supersededBy: 'knowledge_fact:p1v2',
            eps: ['episode:stale'],
          }),
          'knowledge_fact:p1v2': parent('knowledge_fact:p1v2', 'new', {
            eps: ['episode:current'],
          }),
        },
      });
      await svc.recompute('co_x');
      const write = queries.find((q) => q.sql.includes('staleAt = NONE'));
      expect(write!.params.episodeIds).toEqual(['episode:current']);
    });

    it('flag ON, unstamped parents: the fragment clears the field with NONE', async () => {
      process.env.PROVENANCE_SUMMARY_EPISODE_STAMP = '1';
      const { svc, queries } = make({
        stale: [staleSummary],
        parents: {
          'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin'),
          'knowledge_fact:p2': parent('knowledge_fact:p2', 'Dublin'),
        },
      });
      await svc.recompute('co_x');
      const write = queries.find((q) => q.sql.includes('staleAt = NONE'));
      expect(write!.sql).toContain('source.episodeIds = NONE');
      expect(write!.params.episodeIds).toBeUndefined();
    });

    it('the parent SELECTs carry the grounding stamp column', async () => {
      const { svc, queries } = make({ stale: [staleSummary], parents: stampedParents });
      await svc.recompute('co_x');
      const batch = queries.find((q) => q.sql.includes('WHERE id INSIDE $ids'));
      expect(batch!.sql).toContain('source.episodeIds AS eps');
    });
  });

  /**
   * Typed support graph (Drift-5, PROVENANCE_SUPPORT_EDGES): recompose
   * REWRITES derivedFrom, so its typed mirror is REPLACED — the stale
   * edges deleted by the two-step LET-select-ids → DELETE idiom
   * (mandatory: `in` is under the compound support_edge_uq index, the
   * 3.2.4 DELETE-WHERE planner no-op), then the new set inserted. Off
   * (default) the query log carries NO memory_support statement.
   */
  describe('rewrite — derived_from edge mirror (PROVENANCE_SUPPORT_EDGES)', () => {
    const saved = process.env.PROVENANCE_SUPPORT_EDGES;
    afterEach(() => {
      if (saved === undefined) delete process.env.PROVENANCE_SUPPORT_EDGES;
      else process.env.PROVENANCE_SUPPORT_EDGES = saved;
    });

    const staleSummary = {
      id: 'knowledge_fact:sum1',
      predicate: 'summary_lives_in',
      derivedFrom: ['knowledge_fact:p1', 'knowledge_fact:p2'],
      staleAt: '2023-06-01T00:00:00Z',
    };
    const parents = {
      'knowledge_fact:p1': parent('knowledge_fact:p1', 'Berlin'),
      'knowledge_fact:p2': parent('knowledge_fact:p2', 'Dublin', {
        validFrom: '2023-02-01T00:00:00Z',
      }),
    };

    it('flag OFF (default): no memory_support statement in the log', async () => {
      delete process.env.PROVENANCE_SUPPORT_EDGES;
      const { svc, queries } = make({ stale: [staleSummary], parents });
      await svc.recompute('co_x');
      expect(queries.filter((q) => q.sql.includes('memory_support'))).toEqual([]);
    });

    it('flag ON: two-step delete of the stale mirror, then the re-insert of the CURRENT parents', async () => {
      process.env.PROVENANCE_SUPPORT_EDGES = '1';
      const { svc, queries } = make({ stale: [staleSummary], parents });
      await svc.recompute('co_x');
      const support = queries.filter((q) => q.sql.includes('memory_support'));
      expect(support).toHaveLength(2);
      // 1. The two-step erase — string-pinned: a `DELETE memory_support
      //    WHERE` here would be the 3.2.4 silent no-op.
      expect(support[0]!.sql).toContain(`LET $edgeIds = (SELECT VALUE id FROM memory_support`);
      expect(support[0]!.sql).toContain(`WHERE in = $summary AND kind = 'derived_from'`);
      expect(support[0]!.sql).toContain('DELETE $edgeIds');
      expect(String(support[0]!.params.summary)).toBe('knowledge_fact:sum1');
      // 2. The re-insert mirrors the rewritten derivedFrom (chronological
      //    parent order), writer 'recompose'.
      expect(support[1]!.sql).toContain('INSERT RELATION IGNORE INTO memory_support');
      const rows = (support[1]!.params.rows as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        in: String(r.in),
        out: String(r.out),
      }));
      expect(rows).toEqual([
        {
          in: 'knowledge_fact:sum1',
          out: 'knowledge_fact:p1',
          kind: 'derived_from',
          writer: 'recompose',
        },
        {
          in: 'knowledge_fact:sum1',
          out: 'knowledge_fact:p2',
          kind: 'derived_from',
          writer: 'recompose',
        },
      ]);
    });
  });
});
