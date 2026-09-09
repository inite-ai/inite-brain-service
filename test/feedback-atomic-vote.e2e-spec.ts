/**
 * F8 (audit 2026-09-06) against a REAL SurrealDB: two concurrent votes from
 * the same caller key leave one standing vote AND one `+1` in the 0107
 * rollup. Before, the prior vote was read in a separate round-trip from
 * the write, so both requests saw "no prior vote", the UNIQUE index kept
 * one row, and `memory_outcome_stat.confirmedCount` counted it twice.
 */
import { AppFixture, createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

interface StatRow {
  confirmedCount: number;
  rejectedCount: number;
}

describe('feedback: one standing vote, one rollup delta (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_feedback_atomic_e2e' });
    process.env.OUTCOME_TELEMETRY_ENABLED = '1';
  });

  afterAll(async () => {
    delete process.env.OUTCOME_TELEMETRY_ENABLED;
    if (f) await f.close();
  });

  const tail = (factId: string) => factId.split(':')[1];

  const statFor = async (factId: string): Promise<StatRow | null> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[StatRow[]]>(
        `SELECT confirmedCount, rejectedCount FROM memory_outcome_stat
          WHERE subjectId = type::record('knowledge_fact', $tail)`,
        { tail: tail(factId) },
      );
      return (rows as StatRow[])?.[0] ?? null;
    });
  };

  const standingVotes = async (factId: string): Promise<string[]> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<[Array<{ verdict: string }>]>(
        `SELECT verdict FROM retrieval_feedback
          WHERE factId = type::record('knowledge_fact', $tail)`,
        { tail: tail(factId) },
      );
      return ((rows as Array<{ verdict: string }>) ?? []).map((r) => r.verdict);
    });
  };

  /** The rollup write is fire-and-forget — poll until it has landed. */
  const settle = async (
    probe: () => Promise<StatRow | null>,
    ok: (s: StatRow | null) => boolean,
  ) => {
    let last = await probe();
    for (let i = 0; i < 50 && !ok(last); i++) {
      await new Promise((r) => setTimeout(r, 100));
      last = await probe();
    }
    return last;
  };

  async function ingestFact(id: string): Promise<string> {
    const r = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id },
        predicate: 'tier',
        object: 'gold',
        validFrom: '2026-01-01',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'fb_bot' },
      });
    expect([200, 201]).toContain(r.status);
    return r.body.factId as string;
  }

  it('two concurrent helpful votes from one key: one row, confirmedCount 1', async () => {
    const factId = await ingestFact('fb_atomic_subject');
    const [a, b] = await Promise.all([
      f.http.post('/v1/feedback').set(auth()).send({ factId, verdict: 'helpful' }),
      f.http.post('/v1/feedback').set(auth()).send({ factId, verdict: 'helpful' }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Exactly one of the two saw the other's vote as its prior.
    expect([a.body.replaced, b.body.replaced].sort()).toEqual([false, true]);
    expect(await standingVotes(factId)).toEqual(['helpful']);
    // Give a wrong second delta every chance to land before asserting.
    const stat = await settle(
      () => statFor(factId),
      (s) => (s?.confirmedCount ?? 0) >= 1,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(await statFor(factId)).toMatchObject({ confirmedCount: 1, rejectedCount: 0 });
    expect(stat).not.toBeNull();
  });

  it('helpful → incorrect moves the standing vote between buckets, never stacks', async () => {
    const factId = await ingestFact('fb_atomic_flip');
    const first = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId, verdict: 'helpful' });
    expect(first.body.replaced).toBe(false);
    await settle(
      () => statFor(factId),
      (s) => (s?.confirmedCount ?? 0) >= 1,
    );
    const second = await f.http
      .post('/v1/feedback')
      .set(auth())
      .send({ factId, verdict: 'incorrect', reason: 'tier is silver' });
    expect(second.status).toBe(201);
    expect(second.body.replaced).toBe(true);
    const flipped = await settle(
      () => statFor(factId),
      (s) => (s?.rejectedCount ?? 0) >= 1 && (s?.confirmedCount ?? 1) === 0,
    );
    expect(flipped).toMatchObject({ confirmedCount: 0, rejectedCount: 1 });
    expect(await standingVotes(factId)).toEqual(['incorrect']);
  });

  it('concurrent helpful + incorrect from one key: one standing vote, one bucket at 1', async () => {
    const factId = await ingestFact('fb_atomic_mixed');
    const [a, b] = await Promise.all([
      f.http.post('/v1/feedback').set(auth()).send({ factId, verdict: 'helpful' }),
      f.http.post('/v1/feedback').set(auth()).send({ factId, verdict: 'incorrect' }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const votes = await standingVotes(factId);
    expect(votes).toHaveLength(1);
    const stat = await settle(
      () => statFor(factId),
      (s) => (s?.confirmedCount ?? 0) + (s?.rejectedCount ?? 0) >= 1,
    );
    await new Promise((r) => setTimeout(r, 300));
    const final = await statFor(factId);
    expect(stat).not.toBeNull();
    expect((final?.confirmedCount ?? 0) + (final?.rejectedCount ?? 0)).toBe(1);
    // The rollup agrees with whichever vote stands.
    expect(votes[0] === 'helpful' ? final?.confirmedCount : final?.rejectedCount).toBe(1);
  });
});
