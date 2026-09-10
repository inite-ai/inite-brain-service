/**
 * Scene retrieval lane (RETRIEVAL_SCENE_LANE) — unit coverage of the
 * fence stack, the render contract and the degrade seams, over a
 * scripted Surreal double (the belief-lane.unit-spec sibling):
 *
 *  - world selection: the lane reads the version the projection
 *    registry marks 'live'; no live row ⇒ EMPTY with NO scene query;
 *  - scoped-user fence: `userId === undefined` ⇒ EMPTY and NO query at
 *    all (deliberately stricter than the four segment seams, where an
 *    unscoped M2M read serves the tenant-global surface);
 *  - WHERE composition: the 0117 per-member gate, the text PII gate,
 *    the version pin and the or_terms BM25 leg;
 *  - the 0117 fences matrix: a cross-user scene NEVER renders, a
 *    `userIds IS NONE` scene fails closed, a member of a mixed scene
 *    sees it, a non-member does not;
 *  - render: `[memory_episode:...] (<span> UTC) <gist>` with the
 *    notable-details clause from unexpectedDetails, occurredFrom
 *    ascending, 600-char gist cap, TOP_K = 2, byId = the rendered set;
 *  - degrade: a query failure degrades the lane to empty, never a throw;
 *  - the DENSE leg (PR3): fuses with BM25 by RRF when the 0106 gist
 *    vectors exist, and degrades to today's BM25-only ordering when they
 *    do not — both pinned;
 *  - collector gating: profile.sceneLane off ⇒ the lane is NEVER called
 *    (pinned with a throwing stub) and the prompt is byte-identical.
 */
import type { EmbedderService } from '../src/ai/embedder.service';
import { SceneLaneService } from '../src/synthesize/scene-lane.service';
import { sceneStamp } from '../src/synthesize/evidence-visibility';
import { EvidenceCollectorService } from '../src/synthesize/evidence-collector.service';
import { buildGeneratorUserMessage } from '../src/synthesize/generator-prompt';
import type { SearchService, SearchHit } from '../src/search/search.service';
import type { SurrealService } from '../src/db/surreal.service';
import { resolveRetrievalProfile, type RetrievalProfile } from '../src/search/retrieval-profile';

const WORLD = 'scene-segmenter-v1';

interface SceneRowFixture {
  id: string;
  userId?: string | undefined;
  userIds?: string[] | undefined;
  sceneLabel: string;
  gist: string;
  unexpectedDetails?: string[] | undefined;
  occurredFrom: string;
  occurredTo: string;
  score: number;
  /** Projected for the JS re-check (fences 3 and 5) — see sceneVisible. */
  piiClass?: string[] | undefined;
  segmenterVersion?: string;
}

const GIST =
  '2026-07-01 10:00–10:01 · user, assistant · 2 turns — opens: "here is the signed lease scan" — closes: "scan received and filed"';

const row = (over: Partial<SceneRowFixture>): SceneRowFixture => ({
  id: 'memory_episode:s1',
  userId: 'u1',
  userIds: ['u1'],
  sceneLabel: 'lease scan intake',
  gist: GIST,
  occurredFrom: '2026-07-01T10:00:00.000Z',
  occurredTo: '2026-07-01T10:01:00.000Z',
  score: 1,
  segmenterVersion: WORLD,
  ...over,
});

/** Scripted Surreal double: routes by query text, records every call. */
function surrealOf(opts: {
  rows?: SceneRowFixture[];
  /** Registry answer; [] models "no live scene world". */
  live?: string[];
  failRetrieval?: boolean;
}) {
  const calls: Array<{ sql: string; params: Record<string, unknown> | undefined }> = [];
  const db = {
    query: async (sql: string, params?: Record<string, unknown>) => {
      calls.push({ sql, params });
      if (opts.failRetrieval) throw new Error('boom');
      if (sql.includes('FROM projection')) return [opts.live ?? [WORLD]];
      if (sql.includes('FROM memory_episode')) return [opts.rows ?? []];
      return [[]];
    },
  };
  const surreal = {
    withCompany: async (_companyId: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as SurrealService;
  return { surreal, calls };
}

const baseOpts = {
  companyId: 'co_scene',
  query: 'what happened with the lease scan?',
  callerScopes: [] as string[],
  userId: 'u1' as string | undefined,
};

type RecordedCall = { sql: string; params: Record<string, unknown> | undefined };

const sceneQueries = (calls: RecordedCall[]) =>
  calls.filter((c) => c.sql.includes('FROM memory_episode'));

describe('SceneLaneService — world selection (the registry IS the activation record)', () => {
  it('pins the scene query to the version the registry marks live', async () => {
    const { surreal, calls } = surrealOf({
      rows: [row({})],
      live: ['scene-segmenter-v1+ab12cd34'],
    });
    await new SceneLaneService(surreal).sceneLines(baseOpts);
    const registry = calls.filter((c) => c.sql.includes('FROM projection'));
    expect(registry).toHaveLength(1);
    expect(registry[0]!.sql).toContain("name = 'scenes'");
    expect(registry[0]!.sql).toContain("status = 'live'");
    const scenes = sceneQueries(calls);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.sql).toContain('segmenterVersion = $world');
    expect(scenes[0]!.params).toMatchObject({ world: 'scene-segmenter-v1+ab12cd34' });
  });

  it('NO live world ⇒ EMPTY, and the scene table is never queried (fail-closed)', async () => {
    const { surreal, calls } = surrealOf({ rows: [row({})], live: [] });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
    expect(sceneQueries(calls)).toEqual([]);
  });
});

describe('SceneLaneService — the fence stack', () => {
  it('undefined userId ⇒ EMPTY and NO query is ever issued (scoped-user-only)', async () => {
    const { surreal, calls } = surrealOf({ rows: [row({})] });
    const out = await new SceneLaneService(surreal).sceneLines({ ...baseOpts, userId: undefined });
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('composes the 0117 per-member gate, the PII gate and the or_terms BM25 leg', async () => {
    const { surreal, calls } = surrealOf({ rows: [row({})] });
    await new SceneLaneService(surreal).sceneLines(baseOpts);
    const sql = sceneQueries(calls)[0]!.sql;
    // The 0117 read contract, verbatim: own rows, OR userId-NONE rows
    // with a PERSISTED member set that is [] or contains the caller.
    expect(sql).toContain('userId = $scopeUserId');
    expect(sql).toContain('userIds IS NOT NONE');
    expect(sql).toContain('array::len(userIds) = 0 OR userIds CONTAINS $scopeUserId');
    // Text PII gate (no brain:read_pii on the caller).
    expect(sql).toContain('AND piiClass IS NONE');
    // The disjunctive BM25 leg over the 0106 gist FULLTEXT index — NOT a
    // phrase-shaped `@1@ $query` (AND-semantics would need the whole
    // question inside one gist).
    expect(sql).toContain('gist @1@ $t0');
    expect(sql).toContain('math::sum(');
    expect(sceneQueries(calls)[0]!.params).toMatchObject({ scopeUserId: 'u1' });
  });

  it('brain:read_pii lifts the PII gate; without it the clause is present', async () => {
    const { surreal, calls } = surrealOf({ rows: [row({})] });
    await new SceneLaneService(surreal).sceneLines({
      ...baseOpts,
      callerScopes: ['brain:read_pii'],
    });
    expect(sceneQueries(calls)[0]!.sql).not.toContain('piiClass IS NONE');
  });

  it('a PII-tagged scene never reaches a caller without brain:read_pii (SQL fence)', async () => {
    // The double returns whatever the WHERE would have excluded only if
    // the lane forgot the gate — so the pin is the clause above plus
    // this end-to-end shape: the gate rides EVERY scene read.
    const { surreal, calls } = surrealOf({ rows: [] });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(sceneQueries(calls)[0]!.sql).toContain('AND piiClass IS NONE');
  });
});

describe('SceneLaneService — the fences matrix (JS re-check, fail-closed)', () => {
  const render = async (rows: SceneRowFixture[], userId = 'u1') => {
    const { surreal } = surrealOf({ rows });
    return new SceneLaneService(surreal).sceneLines({ ...baseOpts, userId });
  };

  it('a CROSS-USER scene NEVER renders, even if the SQL fence let it through', async () => {
    const out = await render([row({ id: 'memory_episode:other', userId: 'u2', userIds: ['u2'] })]);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });

  it('a `userIds IS NONE` scene FAILS CLOSED (the 0117 legacy-row rule)', async () => {
    const out = await render([
      row({ id: 'memory_episode:legacy', userId: undefined, userIds: undefined }),
    ]);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });

  it('a purely tenant-global scene (userIds = []) renders for a scoped caller', async () => {
    const out = await render([
      row({ id: 'memory_episode:global', userId: undefined, userIds: [] }),
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain('[memory_episode:global]');
  });

  it('a MIXED-user scene renders for a MEMBER and not for a non-member', async () => {
    const mixed = row({ id: 'memory_episode:mixed', userId: undefined, userIds: ['u1', 'u2'] });
    const member = await render([mixed], 'u1');
    expect(member.lines).toHaveLength(1);
    const stranger = await render([mixed], 'u3');
    expect(stranger.lines).toEqual([]);
    expect(stranger.byId.size).toBe(0);
  });

  it('a blank owner stamp is hidden (no stamp ⇒ visible to NO ONE)', async () => {
    const out = await render([row({ id: 'memory_episode:blank', userId: '', userIds: undefined })]);
    expect(out.lines).toEqual([]);
  });
});

/**
 * Round-2 audit F1: fences 3 and 5 are re-checked in JS too, through the
 * SAME predicate the answer cache runs on a cached serve. The double
 * returns rows the WHERE would have dropped, so only the JS half can.
 */
describe('SceneLaneService — JS re-check of the PII and world fences (round-2 F1)', () => {
  const render = async (over: Partial<SceneRowFixture>, callerScopes: string[] = []) => {
    const { surreal } = surrealOf({ rows: [row(over)] });
    return new SceneLaneService(surreal).sceneLines({ ...baseOpts, callerScopes });
  };

  it('drops a piiClass-stamped scene without brain:read_pii, renders it with', async () => {
    expect((await render({ piiClass: ['person'] })).lines).toEqual([]);
    expect((await render({ piiClass: ['person'] }, ['brain:read_pii'])).lines).toHaveLength(1);
  });

  it('drops a scene from a world the registry no longer marks live', async () => {
    // Promotion demotes the previous version to 'residual' WITHOUT
    // deleting rows, so nothing on the scene itself changes.
    expect((await render({ segmenterVersion: 'scene-segmenter-v0' })).lines).toEqual([]);
  });
});

const DETAILED_ROW = row({
  unexpectedDetails: ['the lease was signed by a third party', 'landlord named for the first time'],
});

describe('SceneLaneService — render + degrade', () => {
  it('renders the id-headed, span-stamped line with the notable-details clause', async () => {
    const { surreal } = surrealOf({ rows: [DETAILED_ROW] });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines).toEqual([
      `[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) ${GIST}` +
        ' — notable details: the lease was signed by a third party; landlord named for the first time',
    ]);
    expect(out.byId.get('memory_episode:s1')).toEqual({
      sceneId: 'memory_episode:s1',
      sceneLabel: 'lease scan intake',
      excerpt: GIST,
      occurredAt: '2026-07-01T10:00:00.000Z',
      // The retrieval-time lifecycle stamp over the fields this lane
      // renders, carried into answer-cache admission (round-2 audit F4).
      stamp: sceneStamp(DETAILED_ROW),
    });
  });

  it('no unexpectedDetails ⇒ NO clause (an unenriched scene renders bare)', async () => {
    const { surreal } = surrealOf({ rows: [row({})] });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines).toEqual([`[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) ${GIST}`]);
    expect(out.lines[0]).not.toContain('notable details');
  });

  it('drops blank/non-string details, collapses whitespace and caps the list at 3', async () => {
    const { surreal } = surrealOf({
      rows: [
        row({
          unexpectedDetails: [
            '  a\n  b  ',
            '',
            42 as unknown as string,
            'second',
            'third',
            'fourth (dropped)',
          ],
        }),
      ],
    });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines[0]).toContain('— notable details: a b; second; third');
    expect(out.lines[0]).not.toContain('fourth');
  });

  it('a multi-day scene renders both dates in the span', async () => {
    const { surreal } = surrealOf({
      rows: [row({ occurredTo: '2026-07-02T09:15:00.000Z' })],
    });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines[0]).toContain('(2026-07-01 10:00–2026-07-02 09:15 UTC)');
  });

  it('orders by occurredFrom ascending and caps at SCENE_LANE_TOP_K = 2', async () => {
    const { surreal } = surrealOf({
      rows: [
        row({ id: 'memory_episode:c', occurredFrom: '2026-07-03T10:00:00.000Z', score: 3 }),
        row({ id: 'memory_episode:a', occurredFrom: '2026-07-01T10:00:00.000Z', score: 2 }),
        row({ id: 'memory_episode:b', occurredFrom: '2026-07-02T10:00:00.000Z', score: 1 }),
      ],
    });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    // Top-2 by the DB's score order (c, a), then rendered oldest-first.
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain('[memory_episode:a]');
    expect(out.lines[1]).toContain('[memory_episode:c]');
    expect([...out.byId.keys()].sort()).toEqual(['memory_episode:a', 'memory_episode:c']);
  });

  it('caps the rendered gist at 600 chars', async () => {
    const { surreal } = surrealOf({ rows: [row({ gist: 'x'.repeat(1000) })] });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    const excerpt = out.byId.get('memory_episode:s1')!.excerpt;
    expect(excerpt).toHaveLength(600);
    expect(out.lines[0]!.endsWith(excerpt)).toBe(true);
  });

  it('skips a blank-gist scene (nothing citable, nothing to render)', async () => {
    const { surreal } = surrealOf({ rows: [row({ gist: '   ' })] });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });

  it('a retrieval failure degrades the lane to empty — never a throw', async () => {
    const { surreal } = surrealOf({ failRetrieval: true });
    const out = await new SceneLaneService(surreal).sceneLines(baseOpts);
    expect(out.lines).toEqual([]);
    expect(out.byId.size).toBe(0);
  });
});

/**
 * The dense leg (Brain v2 PR3) — the read side of the 0106
 * `gistEmbedding` column, whose producer (SCENES_GIST_EMBEDDING) landed
 * with it. The leg needs NO switch of its own: it is an internal recall
 * improvement inside a lane already gated by profile.sceneLane, and a
 * world without vectors cannot tell the difference.
 */
describe('SceneLaneService — the dense leg (0106 gistEmbedding)', () => {
  /**
   * Surreal double that answers the dense probe and the BM25 probe
   * SEPARATELY, so the fusion can actually be observed.
   */
  function twoLegSurreal(opts: { dense?: SceneRowFixture[]; bm25?: SceneRowFixture[] }) {
    const calls: RecordedCall[] = [];
    const db = {
      query: async (sql: string, params?: Record<string, unknown>) => {
        calls.push({ sql, params });
        if (sql.includes('FROM projection')) return [[WORLD]];
        if (sql.includes('gistEmbedding != NONE')) return [opts.dense ?? []];
        if (sql.includes('FROM memory_episode')) return [opts.bm25 ?? []];
        return [[]];
      },
    };
    const surreal = {
      withCompany: async (_companyId: string, fn: (d: typeof db) => Promise<unknown>) => fn(db),
    } as unknown as SurrealService;
    return { surreal, calls };
  }

  const embedder = (over: Partial<{ fail: boolean }> = {}) =>
    ({
      embed: async () => {
        if (over.fail) throw new Error('embedder down');
        return [0.1, 0.2, 0.3];
      },
    }) as unknown as EmbedderService;

  const denseQueries = (calls: RecordedCall[]) =>
    calls.filter((c) => c.sql.includes('gistEmbedding != NONE'));

  it('fuses the dense leg with BM25 when vectors exist', async () => {
    // BM25 only finds `b`; the dense leg surfaces `a`, which no query
    // term matches lexically. Fusion must render BOTH.
    const { surreal, calls } = twoLegSurreal({
      dense: [row({ id: 'memory_episode:a', occurredFrom: '2026-07-01T10:00:00.000Z' })],
      bm25: [row({ id: 'memory_episode:b', occurredFrom: '2026-07-02T10:00:00.000Z' })],
    });
    const out = await new SceneLaneService(surreal, embedder()).sceneLines(baseOpts);
    expect(denseQueries(calls)).toHaveLength(1);
    expect(out.lines).toHaveLength(2);
    expect([...out.byId.keys()].sort()).toEqual(['memory_episode:a', 'memory_episode:b']);
  });

  it('the dense leg carries the SAME fence stack as the lexical one', async () => {
    const { surreal, calls } = twoLegSurreal({ dense: [row({})] });
    await new SceneLaneService(surreal, embedder()).sceneLines(baseOpts);
    const dense = denseQueries(calls)[0]!;
    // A dense leg must never be a way around a gate the BM25 leg applies.
    expect(dense.sql).toContain('segmenterVersion = $world');
    expect(dense.sql).toContain('AND piiClass IS NONE');
    expect(dense.sql).toContain('userId = $scopeUserId');
    expect(dense.sql).toContain('userIds IS NOT NONE');
    expect(dense.sql).toContain('vector::similarity::cosine(gistEmbedding, $q)');
    expect(dense.params).toMatchObject({ scopeUserId: 'u1', world: WORLD });
  });

  it('a VECTOR-LESS world degrades to exactly today’s BM25 ordering', async () => {
    const bm25 = [
      row({ id: 'memory_episode:c', occurredFrom: '2026-07-03T10:00:00.000Z', score: 3 }),
      row({ id: 'memory_episode:a', occurredFrom: '2026-07-01T10:00:00.000Z', score: 2 }),
      row({ id: 'memory_episode:b', occurredFrom: '2026-07-02T10:00:00.000Z', score: 1 }),
    ];
    // With vectors: none (the composer never wrote any — the default
    // world). The dense probe returns [], so RRF is a no-op over BM25.
    const withEmbedder = twoLegSurreal({ dense: [], bm25 });
    const fused = await new SceneLaneService(withEmbedder.surreal, embedder()).sceneLines(baseOpts);
    // No embedder wired at all — the pre-PR3 lane, byte for byte.
    const noEmbedder = twoLegSurreal({ bm25 });
    const lexOnly = await new SceneLaneService(noEmbedder.surreal).sceneLines(baseOpts);
    expect(fused.lines).toEqual(lexOnly.lines);
    // And it IS the BM25 top-2 (c, a), rendered oldest-first.
    expect(fused.lines).toHaveLength(2);
    expect(fused.lines[0]).toContain('[memory_episode:a]');
    expect(fused.lines[1]).toContain('[memory_episode:c]');
    // Unwired ⇒ the dense probe is never issued at all.
    expect(denseQueries(noEmbedder.calls)).toEqual([]);
  });

  it('an embedder failure kills the dense leg, never the lane', async () => {
    const { surreal, calls } = twoLegSurreal({ bm25: [row({})] });
    const lane = new SceneLaneService(surreal, embedder({ fail: true }));
    jest
      .spyOn((lane as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const out = await lane.sceneLines(baseOpts);
    expect(denseQueries(calls)).toEqual([]);
    expect(out.lines).toHaveLength(1);
  });

  it('NO live world ⇒ not even the query embedding is computed', async () => {
    const { surreal } = surrealOf({ rows: [row({})], live: [] });
    const throwingEmbedder = {
      embed: async () => {
        throw new Error('the query must not be embedded without a live scene world');
      },
    } as unknown as EmbedderService;
    const out = await new SceneLaneService(surreal, throwingEmbedder).sceneLines(baseOpts);
    expect(out.lines).toEqual([]);
  });
});

describe('EvidenceCollectorService — scene lane gating (profile.sceneLane)', () => {
  const noSearch = { search: async () => ({ results: [] }) } as unknown as SearchService;

  function profileWith(over: Partial<RetrievalProfile>): RetrievalProfile {
    return { ...resolveRetrievalProfile({} as NodeJS.ProcessEnv), ...over } as RetrievalProfile;
  }

  function collectorWith(lane: SceneLaneService | undefined) {
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
      undefined,
      lane,
    );
  }

  const collectArgs = (profile: RetrievalProfile) => ({
    profile,
    lane: null,
    companyId: 'co_scene',
    query: 'what happened with the lease scan?',
    callerScopes: [] as string[],
    factIds: [] as string[],
    evidence: [] as SearchHit[],
    userId: 'u1',
  });

  /** The off-path pin: any call at all is a test failure. */
  const throwingLane = () =>
    ({
      sceneLines: async () => {
        throw new Error('the scene lane must not be called with profile.sceneLane off');
      },
    }) as unknown as SceneLaneService;

  const scriptedLane = (calls: string[]) =>
    ({
      sceneLines: async (o: { query: string }) => {
        calls.push(o.query);
        return {
          lines: ['[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist'],
          byId: new Map([
            [
              'memory_episode:s1',
              {
                sceneId: 'memory_episode:s1',
                sceneLabel: 'lease scan intake',
                excerpt: 'gist',
              },
            ],
          ]),
        };
      },
    }) as unknown as SceneLaneService;

  it('profile.sceneLane off (the default) ⇒ the lane is NEVER called', async () => {
    const out = await collectorWith(throwingLane()).collect(collectArgs(profileWith({})));
    expect(out.sceneLines).toEqual([]);
    expect(out.scenesById).toBeUndefined();
  });

  it('profile.sceneLane on ⇒ lines flow through and scenesById is the rendered set', async () => {
    const called: string[] = [];
    const out = await collectorWith(scriptedLane(called)).collect(
      collectArgs(profileWith({ sceneLane: true })),
    );
    expect(out.sceneLines).toEqual(['[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist']);
    expect(out.scenesById?.size).toBe(1);
    expect(called).toEqual(['what happened with the lease scan?']);
  });

  it('lane unwired ⇒ empty section (partial-wiring degrade)', async () => {
    const out = await collectorWith(undefined).collect(
      collectArgs(profileWith({ sceneLane: true })),
    );
    expect(out.sceneLines).toEqual([]);
    expect(out.scenesById).toBeUndefined();
  });
});

describe('buildGeneratorUserMessage — scene section (RETRIEVAL_SCENE_LANE)', () => {
  const BASE = {
    query: 'what happened with the lease scan?',
    factLines: ['[knowledge_fact:f1] Lease — signed'],
    answerLang: null,
  };

  it('absent / empty ⇒ the prompt is BYTE-IDENTICAL (no section)', () => {
    const base = buildGeneratorUserMessage(BASE);
    expect(buildGeneratorUserMessage({ ...BASE, sceneLines: [] })).toBe(base);
    expect(buildGeneratorUserMessage({ ...BASE, sceneLines: undefined })).toBe(base);
    // Flag-on-with-an-empty-lane is byte-identical too: the header rides
    // the rendered lines, never the switch.
    expect(buildGeneratorUserMessage({ ...BASE, sceneLines: [], sceneCitations: true })).toBe(base);
    expect(base).not.toContain('Episodic record');
  });

  it('rendered lines ⇒ their own section, after beliefs and before media', () => {
    const out = buildGeneratorUserMessage({
      ...BASE,
      beliefLines: ['[semantic_belief:b1] (s — f, rev 1) s'],
      sceneLines: ['[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist'],
      fragmentLines: ['[capability:visual] (image caption) a photo'],
    });
    expect(out.indexOf('Current-state record')).toBeLessThan(out.indexOf('Episodic record'));
    expect(out.indexOf('Episodic record')).toBeLessThan(out.indexOf('Media evidence'));
    expect(out).toContain('[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist');
  });

  it('the citations variant instructs citedSceneIds; the plain one does not', () => {
    const lines = ['[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist'];
    const cited = buildGeneratorUserMessage({ ...BASE, sceneLines: lines, sceneCitations: true });
    const plain = buildGeneratorUserMessage({ ...BASE, sceneLines: lines });
    expect(cited).toContain('copy its id EXACTLY into citedSceneIds');
    expect(plain).not.toContain('citedSceneIds');
    expect(plain).toContain('cite factIds only');
  });

  it('BOTH header variants keep the base abstention rule and send specifics to the facts', () => {
    const lines = ['[memory_episode:s1] (2026-07-01 10:00–10:01 UTC) gist'];
    for (const sceneCitations of [true, false]) {
      const out = buildGeneratorUserMessage({ ...BASE, sceneLines: lines, sceneCitations });
      expect(out).toContain('a scene line is a SUMMARY of a conversation stretch');
      expect(out).toContain('follow the base instructions for an unanswerable question unchanged');
    }
  });
});
