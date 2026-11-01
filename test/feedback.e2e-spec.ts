/**
 * Retrieval feedback loop e2e (migration 0054): the endpoint stores one
 * standing vote per (fact, caller key) — repeat feedback replaces the
 * verdict instead of stacking — and the nightly truth-discovery pass
 * (#847) takes an 'incorrect' vote as an anchor: the rated value is
 * clamped false, so its rival wins and its source loses accuracy.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { CalibrationRefitRunnerService } from '../src/ai/calibration/calibration-refit-runner.service';

describe('retrieval feedback loop', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({
      companyId: 'co_feedback_e2e',
      // A USER-BOUND key: may read tenant-global facts and its own user's,
      // never another user's personal memory (0055).
      extraKeys: [{ scopes: ['brain:read', 'brain:write'], userId: 'bob' }],
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('404s on an unknown fact', async () => {
    const r = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId: 'knowledge_fact:doesnotexist', verdict: 'helpful' });
    expect(r.status).toBe(404);
  });

  it('one standing vote per caller key — repeat replaces, never stacks', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'fb_subject' },
        predicate: 'tier',
        object: 'gold',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'fb_bot' },
      });
    const factId = ingest.body.factId as string;

    const first = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId, verdict: 'helpful' });
    expect(first.status).toBe(201);
    expect(first.body.replaced).toBe(false);

    const second = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId, verdict: 'incorrect', reason: 'tier is actually silver' });
    expect(second.status).toBe(201);
    expect(second.body.replaced).toBe(true);

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ verdict: string; reason: string | null }>]>(
        `SELECT verdict, reason FROM retrieval_feedback
          WHERE factId = type::record('knowledge_fact', $tail)`,
        { tail: factId.split(':')[1] },
      );
      const votes = rows as Array<{ verdict: string; reason: string | null }>;
      expect(votes).toHaveLength(1);
      expect(votes[0]!.verdict).toBe('incorrect');
      expect(votes[0]!.reason).toBe('tier is actually silver');
    });
  });

  it("an 'incorrect' vote clamps the value false: its rival wins, its source loses accuracy", async () => {
    // A second source claims a different tier for the same customer at the
    // same valid time: a contest the vote settles.
    const rival = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'fb_subject' },
        predicate: 'tier',
        object: 'silver',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'fb_crm' },
      });
    expect(rival.status).toBe(201);
    await f.app.get(CalibrationRefitRunnerService).refitSourceTrust();

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [facts] = await db.query<
        [Array<{ object: string; truth: { posterior: number; claims: number } | null }>]
      >(
        `SELECT object, truth FROM knowledge_fact
          WHERE predicate = 'tier' AND source.vertical = 'rent' ORDER BY object`,
      );
      const byObject = new Map((facts ?? []).map((r) => [r.object, r.truth]));
      expect(byObject.get('gold')).toMatchObject({ posterior: 0, claims: 2 });
      expect(byObject.get('silver')).toMatchObject({ posterior: 1, claims: 2 });

      const [rows] = await db.query<
        [Array<{ sourceKey: string; agreementRate: number; method: string }>]
      >(
        `SELECT sourceKey, agreementRate, method FROM source_trust
          WHERE sourceKey IN ['rent:fb_bot', 'rent:fb_crm'] AND domain IS NONE`,
      );
      const rate = new Map((rows ?? []).map((r) => [r.sourceKey, r.agreementRate]));
      expect(rate.get('rent:fb_bot')!).toBeLessThan(0.5);
      expect(rate.get('rent:fb_crm')!).toBeGreaterThan(0.5);
      expect((rows ?? []).every((r) => r.method === 'dawid_skene')).toBe(true);
    });

    // The read side carries it: the entity profile's contested value says
    // how likely it is (#847).
    const [ent] = await surreal.withCompany(f.companyId, async (db) => {
      const [r] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM knowledge_fact WHERE predicate = 'tier' AND object = 'silver' LIMIT 1`,
      );
      return r ?? [];
    });
    const profile = await f.http
      .get(`/v1/entities/${encodeURIComponent(String(ent!.entityId))}`)
      .set(auth());
    expect(profile.status).toBe(200);
    const silver = (profile.body.facts as Array<{ object: string; truth?: unknown }>).find(
      (x) => x.object === 'silver',
    );
    expect(silver?.truth).toEqual({ posterior: 1, claims: 2 });
  });

  it("a user-bound key cannot rate another user's personal fact — 404, never 201", async () => {
    // F2 (audit 2026-09-06): feedback used to check only that the fact id
    // existed, so `brain:write` plus a guessed id could move the trust
    // signals of a fact the caller was not allowed to see, and the 404/201
    // split confirmed the id existed. The vote now passes the read path's
    // own visibility fence.
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'fb_alice_subject' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2026-01-01',
        confidence: 0.9,
        userId: 'alice',
        source: { vertical: 'rent', recorder: 'fb_bot' },
      });
    expect(ingest.status).toBe(201);
    const factId = ingest.body.factId as string;

    const asBob = { Authorization: `Bearer ${f.extraApiKeys[0]}` };
    const foreign = await f.http
      .post('/v1/feedback')
      .set(asBob)
      .send({ factId, verdict: 'incorrect' });
    expect(foreign.status).toBe(404);

    // A tenant-wide (M2M) key acting for no one does not see a personal
    // fact either (#831); acting for alice it may rate hers.
    const unnamed = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId, verdict: 'helpful' });
    expect(unnamed.status).toBe(404);
    const own = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId, verdict: 'helpful', userId: 'alice' });
    expect(own.status).toBe(201);

    const surreal = f.app.get(SurrealService);
    const votes = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[unknown[]]>(
        `SELECT id FROM retrieval_feedback WHERE factId = type::record($fid)`,
        { fid: factId },
      );
      return (rows as unknown[]) ?? [];
    });
    expect(votes).toHaveLength(1);
  });
});
