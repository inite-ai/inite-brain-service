/**
 * e2e for the transaction-time (recordedAt) axis on entity profile and
 * timeline — the backend half of the Timeline page's bitemporal travel.
 *
 * Matrix (fact recorded at tx T1, retracted at tx T2):
 *   recordedAt ∈ (T1, T2) → profile shows the fact as believed active;
 *                           timeline has the recorded event and NO
 *                           retraction event (it hadn't happened yet).
 *   recordedAt > T2       → profile hides it; timeline shows both events.
 *   recordedAt < T1       → the graph knew nothing: no fact, no events.
 * Plus supersede replay: a predecessor is believed active at any tx
 * moment before its successor was recorded (a supersede carries no
 * timestamp of its own — its tx-time is the successor's recordedAt).
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('transaction-time axis — profile/timeline recordedAt', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  // /v1/ingest/fact doesn't surface the entity id — read it off the
  // created fact row (entity record ids are generated, not the ref id).
  const entityIdOfFact = async (factId: string): Promise<string> => {
    const surreal = f.app.get(SurrealService);
    return surreal.withCompany(f.companyId, async (db) => {
      const tail = factId.split(':')[1];
      const [rows] = await db.query<any[][]>(
        `SELECT entityId FROM type::record('knowledge_fact', $tail) LIMIT 1`,
        { tail },
      );
      return String((rows as any[])[0].entityId);
    });
  };

  it('replays record→retract belief states across the tx axis', async () => {
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'tx_axis_customer' },
        predicate: 'tier',
        object: 'platinum',
        validFrom: '2026-01-15',
        source: { vertical: 'rent', eventId: 'billing.tier_set' },
        confidence: 0.9,
      });
    expect(ingest.body.outcome).toBe('INSERTED');
    const factId = ingest.body.factId as string;
    const entity = await entityIdOfFact(factId);

    // Ensure the retraction lands on a strictly later tx millisecond.
    await sleep(150);

    const retract = await f.http
      .post(`/v1/facts/${encodeURIComponent(factId)}/retract`)
      .set(auth())
      .send({
        reason: 'operator correction',
        retractedBy: { source: 'human' },
      });
    expect(retract.status).toBe(201);

    // Learn the exact tx timestamps from the uncut timeline itself —
    // no clock-skew games between the test host and the DB.
    const full = await f.http
      .get(`/v1/entities/${encodeURIComponent(entity)}/timeline`)
      .set(auth());
    expect(full.status).toBe(200);
    const recordedEvt = full.body.events.find(
      (e: any) => e.type === 'fact.recorded' && e.factId === factId,
    );
    const retractedEvt = full.body.events.find(
      (e: any) => e.type === 'fact.retracted' && e.factId === factId,
    );
    expect(recordedEvt).toBeTruthy();
    expect(retractedEvt).toBeTruthy();
    const t1 = new Date(recordedEvt.at).getTime();
    const t2 = new Date(retractedEvt.at).getTime();
    expect(t2).toBeGreaterThan(t1);
    const mid = new Date((t1 + t2) / 2).toISOString();
    const before = new Date(t1 - 1000).toISOString();
    const after = new Date(t2 + 1000).toISOString();

    const profileAt = async (tx: string) => {
      const res = await f.http
        .get(`/v1/entities/${encodeURIComponent(entity)}?recordedAt=${encodeURIComponent(tx)}`)
        .set(auth());
      expect(res.status).toBe(200);
      return res.body.facts.some((x: any) => x.factId === factId);
    };
    const timelineTypesAt = async (tx: string) => {
      const res = await f.http
        .get(
          `/v1/entities/${encodeURIComponent(entity)}/timeline?recordedAt=${encodeURIComponent(tx)}`,
        )
        .set(auth());
      expect(res.status).toBe(200);
      return res.body.events.filter((e: any) => e.factId === factId).map((e: any) => e.type);
    };

    // Between record and retract: believed active, retraction unknown.
    expect(await profileAt(mid)).toBe(true);
    expect(await timelineTypesAt(mid)).toEqual(['fact.recorded']);

    // After the retraction: no longer believed; both events on record.
    expect(await profileAt(after)).toBe(false);
    expect(await timelineTypesAt(after)).toEqual(['fact.recorded', 'fact.retracted']);

    // Before the fact was recorded: the graph knew nothing.
    expect(await profileAt(before)).toBe(false);
    expect(await timelineTypesAt(before)).toEqual([]);
  });

  it('replays supersede belief: predecessor active until its successor is recorded', async () => {
    const a = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'tx_axis_supersede' },
        predicate: 'status',
        object: 'active',
        validFrom: '2026-01-15',
        source: { vertical: 'rent', eventId: 'auth.profile_active' },
        confidence: 0.9,
      });
    expect(a.body.outcome).toBe('INSERTED');
    const aFactId = a.body.factId as string;
    const entity = await entityIdOfFact(aFactId);

    await sleep(150);

    const b = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'tx_axis_supersede' },
        predicate: 'status',
        object: 'churned',
        validFrom: '2026-04-10',
        source: { vertical: 'rent', eventId: 'billing.churn' },
        confidence: 0.9,
      });
    expect(b.body.outcome).toBe('SUPERSEDED');
    expect(b.body.supersededFactIds).toContain(aFactId);
    const bFactId = b.body.factId as string;

    const full = await f.http
      .get(`/v1/entities/${encodeURIComponent(entity)}/timeline`)
      .set(auth());
    const recordedAtOf = (id: string) =>
      new Date(
        full.body.events.find((e: any) => e.type === 'fact.recorded' && e.factId === id).at,
      ).getTime();
    const tA = recordedAtOf(aFactId);
    const tB = recordedAtOf(bFactId);
    expect(tB).toBeGreaterThan(tA);
    const mid = new Date((tA + tB) / 2).toISOString();

    const factIdsAt = async (qs: string) => {
      const res = await f.http.get(`/v1/entities/${encodeURIComponent(entity)}${qs}`).set(auth());
      expect(res.status).toBe(200);
      return res.body.facts.map((x: any) => x.factId);
    };

    // Before the supersede was recorded, A was the believed truth —
    // even though its row now carries supersededBy + a closed window.
    const atMid = await factIdsAt(`?recordedAt=${encodeURIComponent(mid)}`);
    expect(atMid).toContain(aFactId);
    expect(atMid).not.toContain(bFactId);

    // At the present tx moment the successor is the believed truth.
    const now = new Date().toISOString();
    const atNow = await factIdsAt(`?recordedAt=${encodeURIComponent(now)}`);
    expect(atNow).toContain(bFactId);
    expect(atNow).not.toContain(aFactId);

    // Axes stay separate: tx cutoff at mid + world moment asOf — the
    // belief at mid about 2026-02-01 is still A.
    const atMidAsOf = await factIdsAt(
      `?recordedAt=${encodeURIComponent(mid)}&asOf=${encodeURIComponent('2026-02-01T00:00:00Z')}`,
    );
    expect(atMidAsOf).toContain(aFactId);
    expect(atMidAsOf).not.toContain(bFactId);
  });
});
