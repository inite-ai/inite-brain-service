import type { Logger } from '@nestjs/common';
import { runInsightComposer, type InsightComposerSpec } from '../src/admin/insight-composer-kernel';
import type { SurrealService } from '../src/db/surreal.service';
import type { FactEmbeddingService } from '../src/ingest/fact-embedding.service';

/**
 * PRIVACY_COMPOSER_USER_SCOPE — the kernel-level deriver drop idiom.
 *
 * THE DEFECT: the insight composers (aggregates, arcs) selected source
 * facts with NO userId filter and stamped none on composed rows, so one
 * user's personal facts folded into tenant-global summary rows readable
 * by every user. The rule: 0 member users → global (unchanged); exactly
 * 1 → stamp userId + scope; ≥2 → drop the proposal (warn + count).
 * Flag off → byte-identical rows (no userId key at all).
 */
interface StubProposal {
  name: string;
  members: number[];
}

const savedFlag = process.env.PRIVACY_COMPOSER_USER_SCOPE;
afterEach(() => {
  if (savedFlag === undefined) process.env.PRIVACY_COMPOSER_USER_SCOPE = '0';
  else process.env.PRIVACY_COMPOSER_USER_SCOPE = savedFlag;
});

function makeHarness(
  proposals: StubProposal[] | ((lines: string[]) => StubProposal[]),
  extraFacts: Array<Record<string, unknown>> = [],
): {
  run: () => ReturnType<typeof runInsightComposer<StubProposal>>;
  queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }>;
  warnings: string[];
  prompts: string[][];
} {
  const prompts: string[][] = [];
  const queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queries.push({ sql, params });
      if (sql.includes('GROUP BY entityId')) return [[{ entityId: 'knowledge_entity:e1', n: 4 }]];
      if (sql.includes('SELECT canonicalName')) return [[{ canonicalName: 'Melanie' }]];
      if (sql.includes('FROM knowledge_fact'))
        return [
          [
            {
              id: 'knowledge_fact:f0',
              predicate: 'p',
              object: 'o0',
              validFrom: '2026-01-01',
              userId: 'u1',
            },
            {
              id: 'knowledge_fact:f1',
              predicate: 'p',
              object: 'o1',
              validFrom: '2026-01-02',
              userId: 'u1',
            },
            {
              id: 'knowledge_fact:f2',
              predicate: 'p',
              object: 'o2',
              validFrom: '2026-01-03',
              userId: 'u2',
            },
            { id: 'knowledge_fact:f3', predicate: 'p', object: 'o3', validFrom: '2026-01-04' },
            ...extraFacts,
          ],
        ];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_c: string, fn: (d: unknown) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  const embedding = {
    embedMany: async (t: string[]) => t.map(() => [1, 0]),
    activeSpaceId: () => 'stub:test:2:l2',
  } as unknown as FactEmbeddingService;
  const warnings: string[] = [];
  const logger = {
    warn: (m: string) => warnings.push(m),
    log: () => undefined,
  } as unknown as Logger;
  const spec: InsightComposerSpec<StubProposal> = {
    recorder: 'stub-composer-v1',
    sourceExclusionSql: 'AND source.recorder != $recorder',
    sourceExclusionParams: { recorder: 'stub-composer-v1' },
    minFacts: 1,
    propose: async (_name, lines) => {
      prompts.push(lines);
      return typeof proposals === 'function' ? proposals(lines) : proposals;
    },
    valid: (p, facts) => (p.members ?? []).every((m) => m >= 0 && m < facts.length),
    embeddingTextOf: (p) => p.name,
    buildRow: (p) => ({ predicate: `stub_${p.name}`, object: p.name }),
  };
  return {
    queries,
    warnings,
    prompts,
    run: () => runInsightComposer({ surreal, embedding, logger }, spec, { companyId: 'co_x' }),
  };
}

const PROPOSALS: StubProposal[] = [
  { name: 'single', members: [0, 1] }, // u1 only
  { name: 'cross', members: [1, 2] }, // u1 + u2
  { name: 'global', members: [3] }, // no userId
];

function insertedRows(
  queries: Array<{ sql: string; params?: Record<string, unknown> | undefined }>,
): Array<Record<string, unknown>> {
  const tx = queries.find((q) => q.sql.includes('INSERT INTO knowledge_fact'));
  return (tx?.params?.rows as Array<Record<string, unknown>>) ?? [];
}

describe('composer user scope (PRIVACY_COMPOSER_USER_SCOPE)', () => {
  it('fact SELECT projects userId unconditionally (the fold input)', async () => {
    process.env.PRIVACY_COMPOSER_USER_SCOPE = '0';
    const h = makeHarness(PROPOSALS);
    await h.run();
    const factsQ = h.queries.find((q) => q.sql.includes('entityId = $eid AND status'));
    expect(factsQ?.sql).toContain('userId');
  });

  it('flag off: rows byte-identical (no userId/scope key), nothing dropped', async () => {
    process.env.PRIVACY_COMPOSER_USER_SCOPE = '0';
    const h = makeHarness(PROPOSALS);
    const result = await h.run();
    const rows = insertedRows(h.queries);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect('userId' in row).toBe(false);
      expect('scope' in row).toBe(false);
    }
    expect(result.written).toBe(3);
    expect(result.droppedCrossUser).toBe(0);
    expect(h.warnings).toEqual([]);
  });

  it('flag on: each prompt holds one scope — global alone, then global + one user', async () => {
    process.env.PRIVACY_COMPOSER_USER_SCOPE = '1';
    // Every pass proposes one summary over everything it was shown.
    const h = makeHarness((lines) => [
      { name: `all${lines.length}`, members: lines.map((_l, i) => i) },
    ]);
    const result = await h.run();
    const shown = h.prompts.map((p) => p.map((l) => l.split(': ')[1]!.split(' ')[0]));
    expect(shown).toEqual([['o3'], ['o0', 'o1', 'o3'], ['o2', 'o3']]);
    const rows = insertedRows(h.queries);
    expect(rows).toHaveLength(3);
    const global = rows.find((r) => r.predicate === 'stub_all1')!;
    expect('userId' in global).toBe(false);
    const u1 = rows.find((r) => r.predicate === 'stub_all3')!;
    expect(u1.userId).toBe('u1');
    expect(u1.scope).toEqual(['user:u1']);
    const u2 = rows.find((r) => r.predicate === 'stub_all2')!;
    expect(u2.userId).toBe('u2');
    expect(result.written).toBe(3);
    expect(result.droppedCrossUser).toBe(0);
  });

  it('flag on: a user pass keeps only proposals naming that user’s facts', async () => {
    process.env.PRIVACY_COMPOSER_USER_SCOPE = '1';
    // Index of the global fact o3 in each prompt — a global-only proposal.
    const h = makeHarness((lines) => [
      { name: 'globalOnly', members: [lines.findIndex((l) => l.includes(': o3 '))] },
    ]);
    await h.run();
    const rows = insertedRows(h.queries);
    expect(rows).toHaveLength(1);
    expect('userId' in rows[0]!).toBe(false);
  });

  it('a predicate that needs a scope never reaches the prompt (flag on or off)', async () => {
    for (const flag of ['0', '1']) {
      process.env.PRIVACY_COMPOSER_USER_SCOPE = flag;
      const h = makeHarness(PROPOSALS, [
        { id: 'knowledge_fact:f4', predicate: 'dob', object: 'SECRET', validFrom: '2026-01-05' },
      ]);
      await h.run();
      expect(h.prompts.flat().some((l) => l.includes('SECRET'))).toBe(false);
    }
  });

  it('flag on: a proposal without a members array folds to global (no stamp, no drop)', async () => {
    process.env.PRIVACY_COMPOSER_USER_SCOPE = '1';
    const h = makeHarness([{ name: 'memberless' } as unknown as StubProposal]);
    const result = await h.run();
    const rows = insertedRows(h.queries);
    expect(rows).toHaveLength(1);
    expect('userId' in rows[0]!).toBe(false);
    expect(result.droppedCrossUser).toBe(0);
  });
});
