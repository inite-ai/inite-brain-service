/**
 * Belief retrieval lane (BELIEFS_SERVING_LANE) — unit coverage of the
 * fence stack and the degrade seams, over a scripted Surreal double
 * (the fragment-lane.unit-spec sibling):
 *
 *  - D4 scoped-user fence: `userId === undefined` ⇒ EMPTY and NO query
 *    is ever issued (deliberately STRICTER than the read API, where an
 *    M2M credential reads the whole tenant);
 *  - WHERE composition: `userId = $u` + `status = 'active'` on both
 *    legs;
 *  - beliefVisible JS re-check: an out-of-contract row (blank/missing
 *    userId stamp) the SQL fence let through never renders;
 *  - render: one line per (subject, field), `[semantic_belief:...]`
 *    header, validFrom-ascending, 600-char statement cap, TOP_K = 3,
 *    byId = exactly the rendered set;
 *  - degrade: an embedder failure skips the dense leg but keeps BM25;
 *    a query failure degrades the lane to empty, never a throw;
 *  - collector gating: caller-resolved flag off (or lane unwired) ⇒ no
 *    call, empty section.
 */
import { BeliefLaneService } from '../src/synthesize/belief-lane.service';
import { EvidenceCollectorService } from '../src/synthesize/evidence-collector.service';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SurrealService } from '../src/db/surreal.service';
import type { EmbedderService } from '../src/ai/embedder.service';
import { resolveRetrievalProfile, type RetrievalProfile } from '../src/search/retrieval-profile';

interface BeliefRowFixture {
  id: string;
  userId: string;
  subject: string;
  field: string;
  value: string;
  statement: string;
  revision: number;
  validFrom: string;
  score: number;
}

const row = (over: Partial<BeliefRowFixture>): BeliefRowFixture => ({
  id: 'semantic_belief:b1',
  userId: 'u1',
  subject: 'inventory service',
  field: 'database',
  value: 'SurrealDB',
  statement: 'inventory service — database: SurrealDB (was: PostgreSQL)',
  revision: 2,
  validFrom: '2026-08-01T00:00:00.000Z',
  score: 1,
  ...over,
});

/** Scripted Surreal double: routes by query text, records every call. */
function surrealOf(opts: {
  bm25Rows?: BeliefRowFixture[];
  denseRows?: BeliefRowFixture[];
  failRetrieval?: boolean;
}) {
  const calls: Array<{ sql: string; params: Record<string, unknown> | undefined }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (opts.failRetrieval) throw new Error('boom');
      if (sql.includes('vector::similarity')) return [opts.denseRows ?? []];
      if (sql.includes('@1@')) return [opts.bm25Rows ?? []];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_companyId: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  return { surreal, calls };
}

const embedderOk = {
  embed: async () => [0.1, 0.2, 0.3],
} as unknown as EmbedderService;

const embedderBroken = {
  embed: async () => {
    throw new Error('no embedder');
  },
} as unknown as EmbedderService;

const baseOpts = {
  companyId: 'co_belief',
  query: 'which database are we using for the inventory service?',
  userId: 'u1' as string | undefined,
};

describe('BeliefLaneService — D4 scoped-user fence', () => {
  it('undefined userId ⇒ EMPTY and NO query is ever issued (stricter than the read API)', async () => {
    const { surreal, calls } = surrealOf({ bm25Rows: [row({})] });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines({
      ...baseOpts,
      userId: undefined,
    });
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('scoped read: `userId = $u` AND `status = active` on both legs', async () => {
    const { surreal, calls } = surrealOf({ bm25Rows: [row({})] });
    await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    const retrievals = calls.filter((c) => c.sql.includes('FROM semantic_belief'));
    expect(retrievals.length).toBe(2); // dense + BM25
    for (const c of retrievals) {
      expect(c.sql).toContain('userId = $u');
      expect(c.sql).toContain("status = 'active'");
      expect(c.params).toMatchObject({ u: 'u1' });
    }
  });

  it('beliefVisible re-check drops an out-of-contract (blank-stamp) row fail-closed', async () => {
    const { surreal } = surrealOf({
      bm25Rows: [
        row({ id: 'semantic_belief:blank', userId: '' }),
        row({ id: 'semantic_belief:other', userId: 'u2' }),
      ],
    });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });
});

describe('BeliefLaneService — render + degrade', () => {
  it('renders id-headed validFrom-ascending lines, one per (subject, field), and fills byId', async () => {
    const { surreal } = surrealOf({
      bm25Rows: [
        row({}),
        row({
          id: 'semantic_belief:b2',
          subject: 'billing service',
          field: 'queue',
          value: 'nats',
          statement: 'billing service — queue: nats',
          revision: 1,
          validFrom: '2026-07-01T00:00:00.000Z',
          score: 0.5,
        }),
      ],
    });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    expect(out.lines).toEqual([
      '[semantic_belief:b2] (billing service — queue, rev 1, as of 2026-07-01) ' +
        'billing service — queue: nats',
      '[semantic_belief:b1] (inventory service — database, rev 2, as of 2026-08-01) ' +
        'inventory service — database: SurrealDB (was: PostgreSQL)',
    ]);
    expect([...out.byId.keys()].sort()).toEqual(['semantic_belief:b1', 'semantic_belief:b2']);
    expect(out.byId.get('semantic_belief:b1')).toEqual({
      beliefId: 'semantic_belief:b1',
      subject: 'inventory service',
      field: 'database',
      value: 'SurrealDB',
      excerpt: 'inventory service — database: SurrealDB (was: PostgreSQL)',
      occurredAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('dedupes by (subject, field) keeping the best-fused row', async () => {
    const { surreal } = surrealOf({
      bm25Rows: [
        row({ id: 'semantic_belief:best', score: 2 }),
        row({ id: 'semantic_belief:worse', score: 1 }),
      ],
    });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('[semantic_belief:best]');
  });

  it('caps at BELIEF_LANE_TOP_K = 3 lines', async () => {
    const { surreal } = surrealOf({
      bm25Rows: [1, 2, 3, 4, 5].map((i) =>
        row({ id: `semantic_belief:b${i}`, field: `f${i}`, score: 6 - i }),
      ),
    });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    expect(out.lines).toHaveLength(3);
    expect(out.byId.size).toBe(3);
  });

  it('caps the rendered statement at 600 chars', async () => {
    const { surreal } = surrealOf({ bm25Rows: [row({ statement: 'x'.repeat(1000) })] });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    const excerpt = out.byId.get('semantic_belief:b1')!.excerpt;
    expect(excerpt).toHaveLength(600);
    expect(out.lines[0]!.endsWith(excerpt)).toBe(true);
  });

  it('an embedder failure skips the dense leg but keeps the BM25 leg', async () => {
    const { surreal, calls } = surrealOf({ bm25Rows: [row({})] });
    const out = await new BeliefLaneService(surreal, embedderBroken).beliefLines(baseOpts);
    expect(out.lines).toHaveLength(1);
    expect(calls.some((c) => c.sql.includes('vector::similarity'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('@1@'))).toBe(true);
  });

  it('a retrieval failure degrades the lane to empty — never a throw', async () => {
    const { surreal } = surrealOf({ failRetrieval: true });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });
});

describe('BeliefLaneService — date-token disambiguation (BELIEFS_LANE_DATE_DISAMBIGUATION)', () => {
  it('flag off (absent or explicit false) ⇒ the historical `, as of <day>` token, byte-identical', async () => {
    const { surreal } = surrealOf({ bm25Rows: [row({})] });
    const svc = new BeliefLaneService(surreal, embedderOk);
    const absent = await svc.beliefLines(baseOpts);
    const explicit = await svc.beliefLines({ ...baseOpts, dateDisambiguation: false });
    expect(absent.lines).toEqual([
      '[semantic_belief:b1] (inventory service — database, rev 2, as of 2026-08-01) ' +
        'inventory service — database: SurrealDB (was: PostgreSQL)',
    ]);
    expect(explicit.lines).toEqual(absent.lines);
  });

  it('flag on ⇒ `, belief current since <day>` replaces the `as of` token (D4: the day is the REVISION’s validFrom, not an event date)', async () => {
    const { surreal } = surrealOf({ bm25Rows: [row({})] });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines({
      ...baseOpts,
      dateDisambiguation: true,
    });
    expect(out.lines).toEqual([
      '[semantic_belief:b1] (inventory service — database, rev 2, belief current since 2026-08-01) ' +
        'inventory service — database: SurrealDB (was: PostgreSQL)',
    ]);
    expect(out.lines[0]).not.toContain(', as of ');
  });

  it('no-day branch is unchanged in BOTH modes (no date token at all)', async () => {
    const noDay = row({ validFrom: undefined as unknown as string });
    const expected =
      '[semantic_belief:b1] (inventory service — database, rev 2) ' +
      'inventory service — database: SurrealDB (was: PostgreSQL)';
    const { surreal: sOff } = surrealOf({ bm25Rows: [noDay] });
    const off = await new BeliefLaneService(sOff, embedderOk).beliefLines(baseOpts);
    const { surreal: sOn } = surrealOf({ bm25Rows: [noDay] });
    const on = await new BeliefLaneService(sOn, embedderOk).beliefLines({
      ...baseOpts,
      dateDisambiguation: true,
    });
    expect(off.lines).toEqual([expected]);
    expect(on.lines).toEqual([expected]);
  });

  it('byId citation fence is untouched by the flag (keys on beliefId, not the rendered string)', async () => {
    const { surreal } = surrealOf({ bm25Rows: [row({})] });
    const out = await new BeliefLaneService(surreal, embedderOk).beliefLines({
      ...baseOpts,
      dateDisambiguation: true,
    });
    expect(out.byId.get('semantic_belief:b1')).toEqual({
      beliefId: 'semantic_belief:b1',
      subject: 'inventory service',
      field: 'database',
      value: 'SurrealDB',
      excerpt: 'inventory service — database: SurrealDB (was: PostgreSQL)',
      occurredAt: '2026-08-01T00:00:00.000Z',
    });
  });
});

describe('EvidenceCollectorService — belief lane gating', () => {
  const noSearch = { search: async () => ({ results: [] }) } as unknown as SearchService;

  function profileWith(over: Partial<RetrievalProfile>): RetrievalProfile {
    return { ...resolveRetrievalProfile({} as NodeJS.ProcessEnv), ...over } as RetrievalProfile;
  }

  function collectorWith(lane: BeliefLaneService | undefined) {
    return new EvidenceCollectorService(
      noSearch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lane,
    );
  }

  const collectArgs = (beliefLane?: boolean) => ({
    profile: profileWith({}),
    lane: null,
    companyId: 'co_belief',
    query: 'which database',
    callerScopes: [] as string[],
    factIds: [] as string[],
    evidence: [] as SearchHit[],
    userId: 'u1',
    ...(beliefLane !== undefined ? { beliefLane } : {}),
  });

  const scriptedLane = (calls: string[]) =>
    ({
      beliefLines: async (o: { query: string }) => {
        calls.push(o.query);
        return {
          lines: ['[semantic_belief:b1] (s — f, rev 1) s — f: v'],
          byId: new Map([
            [
              'semantic_belief:b1',
              {
                beliefId: 'semantic_belief:b1',
                subject: 's',
                field: 'f',
                value: 'v',
                excerpt: 's — f: v',
              },
            ],
          ]),
        };
      },
    }) as unknown as BeliefLaneService;

  it('caller-resolved flag off (or absent) ⇒ the lane is never called', async () => {
    const called: string[] = [];
    const lane = scriptedLane(called);
    const off = await collectorWith(lane).collect(collectArgs());
    expect(off.beliefLines).toEqual([]);
    expect(off.beliefsById).toBeUndefined();
    const explicit = await collectorWith(lane).collect(collectArgs(false));
    expect(explicit.beliefLines).toEqual([]);
    expect(called).toEqual([]);
  });

  it('flag on ⇒ lines flow through and beliefsById is the rendered set', async () => {
    const called: string[] = [];
    const out = await collectorWith(scriptedLane(called)).collect(collectArgs(true));
    expect(out.beliefLines).toEqual(['[semantic_belief:b1] (s — f, rev 1) s — f: v']);
    expect(out.beliefsById?.size).toBe(1);
    expect(called).toEqual(['which database']);
  });

  it('lane unwired ⇒ empty section (partial-wiring degrade)', async () => {
    const out = await collectorWith(undefined).collect(collectArgs(true));
    expect(out.beliefLines).toEqual([]);
    expect(out.beliefsById).toBeUndefined();
  });

  it('beliefDateDisambiguation (caller-resolved) reaches the lane and is echoed on CollectedEvidence', async () => {
    const seen: Array<boolean | undefined> = [];
    const lane = {
      beliefLines: async (o: { dateDisambiguation?: boolean | undefined }) => {
        seen.push(o.dateDisambiguation);
        return { lines: [], byId: new Map() };
      },
    } as unknown as BeliefLaneService;
    const on = await collectorWith(lane).collect({
      ...collectArgs(true),
      beliefDateDisambiguation: true,
    });
    expect(seen).toEqual([true]);
    expect(on.beliefDateDisambiguation).toBe(true);
    const off = await collectorWith(lane).collect(collectArgs(true));
    expect(seen).toEqual([true, undefined]);
    expect(off.beliefDateDisambiguation).toBeUndefined();
  });
});
