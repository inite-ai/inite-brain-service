/**
 * 0136 answer-cache dependencies e2e (audit 2026-09-06 F3) over a real
 * SurrealDB — the scenario the audit described, end to end:
 *
 *   a MIXED answer (one fact + one belief) is admitted; the fact stays
 *   true ("works at Acme" — here: the Postgres decision) while the belief
 *   is REVISED (the current database moves on). Before 0136 the cached
 *   text kept serving until TTL because only the cited fact was
 *   revalidated; now the belief is a stamped dependency, the revision
 *   invalidates the entry (cause=superseded), and the next request
 *   re-synthesizes and is re-admitted against the NEW revision.
 *
 * Substrate = the belief-serving e2e recipe: a tenant-global fact, an
 * enriched scene with a stateDelta folded by the Belief-A promotion into
 * an active belief for USER, then a SECOND, later scene whose delta
 * supersedes it. Generator/verifier are scripted (mockSynthesizeOpenAi).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { mockSynthesizeOpenAi } from './test-doubles';
import { SurrealService } from '../src/db/surreal.service';

const USER = 'cache_deps_u1';
const QUERY = 'which database does the inventory service use, and what was decided first?';
const VERIFY_SUPPORTED = JSON.stringify({ verdict: 'supported', unsupportedClaims: [] });
const FLAG_KEYS = [
  'SYNTHESIZE_ANSWER_CACHE',
  'BELIEFS_SERVING_LANE',
  'RETRIEVAL_ABSTENTION_CALIBRATION',
  'SCENES_SEGMENTATION_ENABLED',
  'SCENES_BELIEF_PROMOTION',
] as const;

interface BeliefRow {
  id: unknown;
  value: string;
  status: string;
  revision: number;
  supersededBy?: unknown;
}

interface CacheRow {
  answer: string;
  hitCount: number;
  invalidationCause?: string | null;
  dependencies?: Array<{ kind: string; id: string; rev: string }> | null;
}

describe('0136 answer-cache dependencies e2e (a belief revision invalidates a mixed answer)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const savedEnv: Record<string, string | undefined> = {};
  let pgFactId: string;
  let beliefV1: string;

  const db = <T>(
    fn: (d: { query: <Q>(sql: string, p?: Record<string, unknown>) => Promise<Q> }) => Promise<T>,
  ): Promise<T> => f.app.get(SurrealService).withCompany(f.companyId, fn);

  const synth = () =>
    f.http.post('/v1/synthesize').set(auth()).send({ query: QUERY, userId: USER, limit: 5 });

  const beliefs = () =>
    db(async (d) => {
      const [rows] = await d.query<[BeliefRow[]]>(
        `SELECT id, value, status, revision, supersededBy FROM semantic_belief ORDER BY revision`,
      );
      return rows ?? [];
    });

  const cacheRows = () =>
    db(async (d) => {
      const [rows] = await d.query<[CacheRow[]]>(
        `SELECT answer, hitCount, invalidationCause, dependencies FROM answer_cache`,
      );
      return rows ?? [];
    });

  /** Seed one enriched scene carrying a database stateDelta for USER. */
  const seedScene = (id: string, from: string, to: string, at: string) =>
    db(async (d) => {
      await d.query(
        `CREATE type::record('memory_episode', $id) CONTENT {
           userId: $u, userIds: [$u], scope: [],
           sceneLabel: 'db switch', conversationIds: [$conv],
           occurredFrom: <datetime>$at, occurredTo: <datetime>$at,
           gist: $gist, confidence: 1,
           stateDeltas: [{ subject: 'inventory service', field: 'database',
                           from: $from, to: $to }],
           segmenterVersion: 'scene-segmenter-v1', generation: 'seed-gen',
           source: { recorder: 'test-seed' },
           enrichmentVersion: 'seed-enrich-v1',
           enrichedMemoryValue: { explicitness: 0.8 } }`,
        { id, u: USER, conv: `proj:${id}`, at, gist: `switched to ${to}`, from, to },
      );
    });

  const promote = async () => {
    process.env.SCENES_SEGMENTATION_ENABLED = '1';
    process.env.SCENES_BELIEF_PROMOTION = '1';
    try {
      const res = await f.http.post('/v1/admin/maintenance/scenes/beliefs').set(auth()).send({});
      expect(res.status).toBe(201);
      return res.body as { beliefsCreated: number };
    } finally {
      delete process.env.SCENES_SEGMENTATION_ENABLED;
      delete process.env.SCENES_BELIEF_PROMOTION;
    }
  };

  /** One scripted generate+verify round citing the fact AND a belief. */
  const mockMixedRound = (answer: string, beliefId: string) =>
    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer, citedFactIds: [pgFactId], citedBeliefIds: [beliefId] }),
      VERIFY_SUPPORTED,
    ]);

  beforeAll(async () => {
    for (const k of FLAG_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.RETRIEVAL_ABSTENTION_CALIBRATION = 'off';
    process.env.BELIEFS_SERVING_LANE = '1';
    process.env.SYNTHESIZE_ANSWER_CACHE = '1';
    f = await createApp({ companyId: 'co_answer_cache_deps_e2e' });

    const pg = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'proj', id: 'postgresql' },
        predicate: 'code_memory__decided',
        object: 'we will use Postgres as the main database',
        validFrom: new Date('2026-08-01').toISOString(),
        confidence: 0.9,
        source: { vertical: 'proj', recorder: 'bot' },
      });
    expect([200, 201]).toContain(pg.status);
    pgFactId = pg.body.factId as string;

    await seedScene('cachedeps1', 'PostgreSQL', 'SurrealDB', '2026-08-10T10:00:00.000Z');
    expect(await promote()).toMatchObject({ beliefsCreated: 1 });
    const rows = await beliefs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: 'SurrealDB', status: 'active', revision: 1 });
    beliefV1 = String(rows[0]!.id);
  }, 120000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (f) await f.close();
  });

  it('admits the mixed answer WITH the belief as a stamped dependency, then serves it cached', async () => {
    const answer = `Postgres was decided first [${pgFactId}]; the inventory service now uses SurrealDB [${beliefV1}].`;
    const state1 = mockMixedRound(answer, beliefV1);
    const res1 = await synth();
    expect(res1.status).toBe(201);
    expect(res1.body.answer).toBe(answer);
    expect(res1.body.cached).toBeUndefined();
    expect(res1.body.evidenceCitations).toHaveLength(1);
    expect(res1.body.evidenceCitations[0]).toMatchObject({ beliefId: beliefV1 });
    expect(state1.calls).toHaveLength(2);

    // The stored row carries the belief — kind, id and the revision stamp
    // the answer was built against. This is what 0091 dropped (audit F3).
    const stored = await cacheRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.dependencies).toEqual([{ kind: 'belief', id: beliefV1, rev: '1' }]);

    // Served from the cache: no LLM call, the belief arm comes back as an
    // id-only evidence citation, hitCount moves.
    const state2 = mockMixedRound('A DIFFERENT answer that must not surface.', beliefV1);
    const res2 = await synth();
    expect(res2.status).toBe(201);
    expect(res2.body.cached).toBe(true);
    expect(res2.body.answer).toBe(answer);
    expect(res2.body.citations?.[0]?.factId).toBe(pgFactId);
    expect(res2.body.evidenceCitations).toEqual([{ beliefId: beliefV1 }]);
    expect(state2.calls).toHaveLength(0);
    expect((await cacheRows())[0]!.hitCount).toBe(1);
  });

  it('a belief revision invalidates the entry (cause=superseded) while the cited fact is untouched, and the fresh answer is re-admitted against the new revision', async () => {
    // The current state moves on: a LATER scene folds into revision 2 and
    // supersedes revision 1. The fact the answer also cites stays active.
    await seedScene('cachedeps2', 'SurrealDB', 'DynamoDB', '2026-08-20T10:00:00.000Z');
    // A later delta on an existing (subject, field) is a REVISION, not a
    // new belief: revision 2 is created and revision 1 superseded.
    expect(await promote()).toMatchObject({ beliefsRevised: 1 });
    const rows = await beliefs();
    expect(rows).toHaveLength(2);
    const v1 = rows.find((r) => String(r.id) === beliefV1)!;
    expect(v1.status).toBe('superseded');
    const v2 = rows.find((r) => r.revision === 2)!;
    expect(v2).toMatchObject({ value: 'DynamoDB', status: 'active' });
    const beliefV2 = String(v2.id);

    // Check-on-read: the fact still validates, the belief does not — the
    // stale text must NOT surface, the LLM runs again, and the row records
    // the belief's lifecycle cause.
    const fresh = `Postgres was decided first [${pgFactId}]; the inventory service now uses DynamoDB [${beliefV2}].`;
    const state3 = mockMixedRound(fresh, beliefV2);
    const res3 = await synth();
    expect(res3.status).toBe(201);
    expect(res3.body.cached).toBeUndefined();
    expect(res3.body.answer).toBe(fresh);
    expect(state3.calls).toHaveLength(2);

    // Re-admission REPLACES the row in place (same key): the invalidation
    // stamp is gone and the dependency now points at revision 2.
    const after = await cacheRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.answer).toBe(fresh);
    expect(after[0]!.invalidationCause ?? null).toBeNull();
    expect(after[0]!.dependencies).toEqual([{ kind: 'belief', id: beliefV2, rev: '2' }]);

    // …and the new entry serves.
    const state4 = mockMixedRound('must not surface either', beliefV2);
    const res4 = await synth();
    expect(res4.body.cached).toBe(true);
    expect(res4.body.answer).toBe(fresh);
    expect(state4.calls).toHaveLength(0);
  });

  it('an in-place revision bump (same belief row) is dependency_changed, recorded on the row before re-admission replaces it', async () => {
    // The stamp moves while the row stays active: the schema allows only
    // 'active' | 'superseded' for status, so a value change always creates
    // a new revision — but the `revision` counter itself is what the entry
    // was admitted against, and a moved counter must not keep serving.
    const rows = await beliefs();
    const active = rows.find((r) => r.status === 'active')!;
    await db(async (d) => {
      await d.query(`UPDATE $id SET revision = revision + 1, updatedAt = time::now()`, {
        id: active.id,
      });
    });
    // A scripted round that ABSTAINS (no citations) is never admitted, so
    // the invalidated row survives with its cause for inspection.
    mockSynthesizeOpenAi(f.app, [
      JSON.stringify({ answer: 'I do not know.', citedFactIds: [] }),
      JSON.stringify({ verdict: 'unsupported', unsupportedClaims: ['all'] }),
    ]);
    const res = await synth();
    expect(res.status).toBe(201);
    expect(res.body.cached).toBeUndefined();
    const after = await cacheRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.invalidationCause).toBe('dependency_changed');
  });
});
