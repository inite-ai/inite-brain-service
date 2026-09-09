/**
 * Retrieval feedback loop e2e (migration 0054): the endpoint stores one
 * standing vote per (fact, caller key) — repeat feedback replaces the
 * verdict instead of stacking — and the nightly source-trust refit
 * counts 'incorrect' as a loss against the fact's source.
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

  it("the refit counts 'incorrect' as a loss against the fact's source", async () => {
    const refit = f.app.get(CalibrationRefitRunnerService);
    await refit.refitSourceTrust();

    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<
        [Array<{ winCount: number; lossCount: number; sampleCount: number }>]
      >(
        `SELECT winCount, lossCount, sampleCount FROM source_trust
          WHERE sourceKey = 'rent:fb_bot' AND domain IS NONE`,
      );
      const trust = (
        rows as Array<{
          winCount: number;
          lossCount: number;
          sampleCount: number;
        }>
      )[0];
      // The active fact itself is a win; the standing 'incorrect'
      // feedback vote is the loss.
      expect(trust).toBeDefined();
      expect(trust!.lossCount).toBeGreaterThanOrEqual(1);
      expect(trust!.sampleCount).toBeGreaterThanOrEqual(2);
    });
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

    // The tenant-wide (M2M) key still may.
    const own = await f.http.post('/v1/feedback').set(auth()).send({ factId, verdict: 'helpful' });
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
