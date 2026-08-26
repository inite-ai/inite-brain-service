/**
 * Outcome telemetry e2e (migration 0107): with OUTCOME_TELEMETRY_ENABLED
 * the writers append memory_outcome rows and fold memory_outcome_stat
 * counters (fire-and-forget — assertions poll):
 *   (a) feedback helpful/repeat/flip — raw rows accumulate, the rollup
 *       tracks STANDING votes (replace = −1 old / +1 new, repeat nets 0);
 *   (b) a superseding ingest marks the LOSER contradicted;
 *   (c) OUTCOME_RETRIEVED_EVENTS adds the raw retrieved stream while
 *       fact_usage.readCount still increments (compat pin);
 *   (d) GDPR entity-forget + user-forget cascade BOTH tables;
 *   (e) master off ⇒ zero rows (byte-identical);
 *   (f) verified-use SERVING (read side): with RETRIEVAL_VERIFIED_USE_RANKING
 *       + SEARCH_VERIFIED_USE_BETA the enriched fact's score breakdown
 *       carries the verifiedUse factor; flags off ⇒ no fragment.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

interface OutcomeRow {
  event: string;
  actor?: string;
  meta?: Record<string, unknown>;
}

interface StatRow {
  selectedCount: number;
  usedCount: number;
  verifiedUseCount: number;
  confirmedCount: number;
  rejectedCount: number;
  contradictedCount: number;
  lastVerifiedUseAt?: string;
}

describe('memory_outcome — outcome telemetry recording and cascade', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_outcome_e2e' });
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    delete process.env.OUTCOME_RETRIEVED_EVENTS;
    delete process.env.SEARCH_USAGE_RECORDING_ENABLED;
    if (f) await f.close();
  });

  const tail = (factId: string) => factId.split(':')[1];

  const rawRows = async (factId: string, event?: string): Promise<OutcomeRow[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[OutcomeRow[]]>(
        `SELECT event, actor, meta FROM memory_outcome
          WHERE subjectId = type::record('knowledge_fact', $tail)
          ${event ? 'AND event = $event' : ''}`,
        { tail: tail(factId), ...(event ? { event } : {}) },
      );
      return (rows as OutcomeRow[]) ?? [];
    });
  };

  const statFor = async (factId: string): Promise<StatRow | null> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[StatRow[]]>(
        `SELECT * FROM memory_outcome_stat
          WHERE subjectId = type::record('knowledge_fact', $tail)`,
        { tail: tail(factId) },
      );
      return (rows as StatRow[])?.[0] ?? null;
    });
  };

  /** Writers are fire-and-forget — poll until the condition holds. */
  const waitFor = async <T>(probe: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    let last: T = await probe();
    for (let i = 0; i < 40 && !ok(last); i++) {
      await new Promise((r) => setTimeout(r, 100));
      last = await probe();
    }
    return last;
  };

  const ingestFact = async (
    entityId: string,
    predicate: string,
    object: string,
    opts: { validFrom?: string; confidence?: number; userId?: string } = {},
  ): Promise<{ factId: string; outcome: string; supersededFactIds?: string[] }> => {
    const res = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: entityId },
        predicate,
        object,
        validFrom: opts.validFrom ?? '2026-01-01',
        confidence: opts.confidence ?? 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
        ...(opts.userId ? { userId: opts.userId } : {}),
      });
    expect([200, 201]).toContain(res.status);
    return res.body;
  };

  const vote = async (factId: string, verdict: string) => {
    const res = await f.http.post('/v1/feedback').set(auth()).send({ factId, verdict });
    expect([200, 201]).toContain(res.status);
  };

  it('(a) feedback: raw rows accumulate, the rollup tracks standing votes', async () => {
    const { factId } = await ingestFact('outcome_vote_subj', 'name', 'Outcome Vote Subject');

    // First helpful vote → one raw user_confirmed + confirmedCount 1.
    await vote(factId, 'helpful');
    const confirmed1 = await waitFor(
      () => rawRows(factId, 'user_confirmed'),
      (r) => r.length >= 1,
    );
    expect(confirmed1).toHaveLength(1);
    // actor = the caller key hash, never free-form.
    expect(confirmed1[0]!.actor).toMatch(/^sha256:/);
    const stat1 = await waitFor(
      () => statFor(factId),
      (s) => (s?.confirmedCount ?? 0) >= 1,
    );
    expect(stat1).toMatchObject({ confirmedCount: 1, rejectedCount: 0 });
    expect(stat1!.lastVerifiedUseAt).toBeTruthy();

    // Repeat helpful → SECOND raw row (audit trail), stat NETS to 1.
    await vote(factId, 'helpful');
    const confirmed2 = await waitFor(
      () => rawRows(factId, 'user_confirmed'),
      (r) => r.length >= 2,
    );
    expect(confirmed2).toHaveLength(2);
    expect((await statFor(factId))!.confirmedCount).toBe(1);

    // Flip to incorrect → −1 confirmed / +1 rejected (standing vote moves).
    await vote(factId, 'incorrect');
    const rejected = await waitFor(
      () => rawRows(factId, 'user_rejected'),
      (r) => r.length >= 1,
    );
    expect(rejected).toHaveLength(1);
    const statFlipped = await waitFor(
      () => statFor(factId),
      (s) => (s?.rejectedCount ?? 0) >= 1 && (s?.confirmedCount ?? 1) === 0,
    );
    expect(statFlipped).toMatchObject({ confirmedCount: 0, rejectedCount: 1 });
  });

  it('(b) a superseding ingest marks the loser contradicted', async () => {
    const first = await ingestFact('outcome_conflict', 'tier', 'standard', {
      validFrom: '2026-01-01',
      confidence: 0.7,
    });
    expect(first.outcome).toBe('INSERTED');
    const winner = await ingestFact('outcome_conflict', 'tier', 'gold', {
      validFrom: '2026-04-01',
      confidence: 0.95,
    });
    expect(winner.outcome).toBe('SUPERSEDED');
    expect(winner.supersededFactIds).toContain(first.factId);

    const contradicted = await waitFor(
      () => rawRows(first.factId, 'contradicted'),
      (r) => r.length >= 1,
    );
    expect(contradicted).toHaveLength(1);
    // meta is content-free: the winning fact id only.
    expect(contradicted[0]!.meta).toMatchObject({ byFactId: winner.factId });
    const stat = await waitFor(
      () => statFor(first.factId),
      (s) => (s?.contradictedCount ?? 0) >= 1,
    );
    expect(stat!.contradictedCount).toBe(1);
    // The WINNER of a supersede is not contradicted.
    expect(await rawRows(winner.factId, 'contradicted')).toHaveLength(0);
  });

  it('(c) retrieved stream is double-gated AND fact_usage keeps incrementing (compat pin)', async () => {
    process.env.SEARCH_USAGE_RECORDING_ENABLED = '1';
    process.env.OUTCOME_RETRIEVED_EVENTS = '1';
    try {
      const { factId } = await ingestFact('outcome_probe', 'name', 'Outcome Probe Tenant');
      const search = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: 'Outcome Probe Tenant', limit: 5 });
      expect(search.status).toBe(201);
      expect(search.body.results.length).toBeGreaterThan(0);

      const retrieved = await waitFor(
        () => rawRows(factId, 'retrieved'),
        (r) => r.length >= 1,
      );
      expect(retrieved.length).toBeGreaterThanOrEqual(1);
      // retrieved is raw-stream only: NO rollup counter for it.
      expect((await statFor(factId))?.contradictedCount ?? 0).toBe(0);

      // Compat pin: the 0053 fact_usage stamp is untouched by 0107.
      const surreal = f.app.get(SurrealService);
      const usage = await waitFor(
        () =>
          surreal.withCompany(f.companyId, async (db) => {
            const [rows] = await db.query<[Array<{ readCount: number }>]>(
              `SELECT readCount FROM fact_usage
                WHERE factId = type::record('knowledge_fact', $tail)`,
              { tail: tail(factId) },
            );
            return (rows as Array<{ readCount: number }>)?.[0] ?? null;
          }),
        (u) => (u?.readCount ?? 0) >= 1,
      );
      expect(usage!.readCount).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.SEARCH_USAGE_RECORDING_ENABLED;
      delete process.env.OUTCOME_RETRIEVED_EVENTS;
    }
  });

  it('(d) GDPR: entity-forget and user-forget cascade both tables', async () => {
    // Entity leg — seed outcome rows via a vote, then erase the entity.
    const { factId } = await ingestFact('outcome_forget_subj', 'name', 'Outcome Forget Subject');
    await vote(factId, 'helpful');
    await waitFor(
      () => statFor(factId),
      (s) => (s?.confirmedCount ?? 0) >= 1,
    );

    const surreal = f.app.get(SurrealService);
    const entityId = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ entityId: unknown }>]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail)`,
        { tail: tail(factId) },
      );
      return String((rows as Array<{ entityId: unknown }>)?.[0]?.entityId);
    });
    const forget = await f.http
      .post(`/v1/entities/${encodeURIComponent(entityId)}/forget`)
      .set(auth())
      .send({ reason: 'gdpr_request', requestId: 'req-outcome-1' });
    expect([200, 201]).toContain(forget.status);
    expect(await rawRows(factId)).toHaveLength(0);
    expect(await statFor(factId)).toBeNull();

    // User leg — a user-scoped fact's telemetry dies with the user slice.
    const userFact = await ingestFact('outcome_user_subj', 'name', 'Outcome User Subject', {
      userId: 'user_outcome_1',
    });
    await vote(userFact.factId, 'helpful');
    await waitFor(
      () => statFor(userFact.factId),
      (s) => (s?.confirmedCount ?? 0) >= 1,
    );

    const userForget = await f.http.post('/v1/users/user_outcome_1/forget').set(auth()).send({});
    expect([200, 201]).toContain(userForget.status);
    expect(await rawRows(userFact.factId)).toHaveLength(0);
    expect(await statFor(userFact.factId)).toBeNull();
  });

  it('(f) verified-use serving: the ranking flag surfaces the verifiedUse breakdown factor; flags off ⇒ no fragment', async () => {
    interface WireFact {
      factId: string;
      breakdown?: { verifiedUse?: { count: number; factor: number } };
    }
    const factsFor = (body: { results: Array<{ facts: WireFact[] }> }): WireFact[] =>
      body.results.flatMap((r) => r.facts);

    // Seed: one fact + a confirmed vote → memory_outcome_stat row with
    // confirmedCount 1 ⇒ verifiedUseScore 1 on the read side.
    const { factId } = await ingestFact('outcome_serving', 'name', 'Verified Serving Subject');
    await vote(factId, 'helpful');
    await waitFor(
      () => statFor(factId),
      (s) => (s?.confirmedCount ?? 0) >= 1,
    );

    // Flags off (default): the fragment must be absent — byte-identical.
    const before = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Verified Serving Subject', limit: 5 });
    expect(before.status).toBe(201);
    const beforeFact = factsFor(before.body).find((x) => x.factId === factId);
    expect(beforeFact).toBeDefined();
    expect(beforeFact!.breakdown?.verifiedUse).toBeUndefined();

    process.env.RETRIEVAL_VERIFIED_USE_RANKING = '1';
    process.env.SEARCH_VERIFIED_USE_BETA = '0.3';
    try {
      const after = await f.http
        .post('/v1/search')
        .set(auth())
        .send({ query: 'Verified Serving Subject', limit: 5 });
      expect(after.status).toBe(201);
      const served = factsFor(after.body).find((x) => x.factId === factId);
      expect(served).toBeDefined();
      // The "because" fragment: attached score + the saturating factor
      // (1 + 0.3·log1p(1)/log1p(10) ≈ 1.0867 at the default saturation).
      expect(served!.breakdown?.verifiedUse).toBeDefined();
      expect(served!.breakdown!.verifiedUse!.count).toBeGreaterThanOrEqual(1);
      expect(served!.breakdown!.verifiedUse!.factor).toBeGreaterThan(1);
      expect(served!.breakdown!.verifiedUse!.factor).toBeLessThanOrEqual(1.3);
    } finally {
      delete process.env.RETRIEVAL_VERIFIED_USE_RANKING;
      delete process.env.SEARCH_VERIFIED_USE_BETA;
    }
  });

  it('(e) master off ⇒ zero rows written (byte-identical)', async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    try {
      const { factId } = await ingestFact('outcome_off_subj', 'name', 'Outcome Off Subject');
      await vote(factId, 'helpful');
      // Supersede path too — no contradicted rows either.
      const off1 = await ingestFact('outcome_off_conflict', 'tier', 'standard', {
        validFrom: '2026-01-01',
        confidence: 0.7,
      });
      await ingestFact('outcome_off_conflict', 'tier', 'gold', {
        validFrom: '2026-04-01',
        confidence: 0.95,
      });
      // Fire-and-forget writers: give any (buggy) write time to land.
      await new Promise((r) => setTimeout(r, 500));
      expect(await rawRows(factId)).toHaveLength(0);
      expect(await statFor(factId)).toBeNull();
      expect(await rawRows(off1.factId)).toHaveLength(0);
      expect(await statFor(off1.factId)).toBeNull();
    } finally {
      process.env.OUTCOME_TELEMETRY_ENABLED = '1';
    }
  });
});
