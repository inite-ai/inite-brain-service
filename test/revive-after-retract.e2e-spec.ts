/**
 * e2e regression for the memlc.cycle.update-then-retract scenario the
 * quality-eval surfaced as a real semantic bug.
 *
 * Sequence:
 *   t1: ingest status='active'  (validFrom 2026-01-15)
 *   t2: ingest status='churned' (validFrom 2026-04-10)
 *           → fn::resolve_fact marks t1 superseded, validUntil = t2.validFrom,
 *             priorValidUntil = t1's prior validUntil (NONE here),
 *             supersededBy = t2_id
 *   t3: POST /v1/facts/{t2_id}/retract
 *           → t2: status='retracted', retractedAt set
 *           → t1 must be revived: status='active', validUntil=NONE,
 *             supersededBy=NONE
 *
 * Default search after t3 must surface object='active' on the entity.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';

describe('revive after retract — memlc.cycle scenario', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('revives a superseded fact when its superseder is retracted', async () => {
    // Seed name so search-by-name has something to anchor on.
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'revive_cycle_customer' },
      predicate: 'name',
      object: 'Revive Cycle Customer',
      validFrom: '2026-01-01',
      source: { vertical: 'rent', eventId: 'auth.profile_created' },
      confidence: 0.95,
    });

    const activeIngest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'revive_cycle_customer' },
        predicate: 'status',
        object: 'active',
        validFrom: '2026-01-15',
        source: { vertical: 'rent', eventId: 'auth.profile_active' },
        confidence: 0.9,
      });
    expect(activeIngest.body.outcome).toBe('INSERTED');
    const activeFactId = activeIngest.body.factId as string;

    const churnIngest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'revive_cycle_customer' },
        predicate: 'status',
        object: 'churned',
        validFrom: '2026-04-10',
        source: { vertical: 'rent', eventId: 'billing.churn' },
        confidence: 0.9,
      });
    expect(churnIngest.body.outcome).toBe('SUPERSEDED');
    expect(churnIngest.body.supersededFactIds).toContain(activeFactId);
    const churnFactId = churnIngest.body.factId as string;

    // Sanity: after supersede, default search must surface "churned"
    // (the surviving truth), NOT "active".
    const searchAfterSupersede = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Revive Cycle Customer status', limit: 5 });
    expect(searchAfterSupersede.status).toBe(201);
    const objectsAfterSupersede = searchAfterSupersede.body.results
      .flatMap((r: any) => r.facts)
      .map((f: any) => f.object as string);
    expect(objectsAfterSupersede).toContain('churned');
    expect(objectsAfterSupersede).not.toContain('active');

    // Retract the churn fact — this is the scenario the eval covers.
    const retract = await f.http
      .post(`/v1/facts/${encodeURIComponent(churnFactId)}/retract`)
      .set(auth())
      .send({
        reason: 'operator mistakenly recorded churn for the wrong account',
        retractedBy: { source: 'system' },
      });
    expect(retract.status).toBe(201);
    expect(retract.body.revivedFactIds).toEqual(
      expect.arrayContaining([activeFactId]),
    );

    // Post-retract default search must now surface "active" — the
    // previously-superseded fact has been revived.
    const searchAfterRetract = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Revive Cycle Customer status', limit: 5 });
    expect(searchAfterRetract.status).toBe(201);
    const objectsAfterRetract = searchAfterRetract.body.results
      .flatMap((r: any) => r.facts)
      .map((f: any) => f.object as string);
    expect(objectsAfterRetract).toContain('active');
    expect(objectsAfterRetract).not.toContain('churned');
  });

  it('does not revive a fact that was separately retracted on its own merits', async () => {
    // Seed three status updates A → B → C. Operator retracts B
    // before C is ingested. When C is later retracted (operator
    // changed their mind on C too), only A should revive, not B —
    // B carries an independent retractionReason and stays hidden.
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'revive_chain_tenant' },
      predicate: 'name',
      object: 'Revive Chain Tenant',
      validFrom: '2026-01-01',
      source: { vertical: 'rent', eventId: 'auth.profile_created' },
      confidence: 0.95,
    });

    const aRes = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'revive_chain_tenant' },
      predicate: 'status',
      object: 'A',
      validFrom: '2026-02-01',
      source: { vertical: 'rent', eventId: 'evt-a' },
      confidence: 0.9,
    });
    const bRes = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'revive_chain_tenant' },
      predicate: 'status',
      object: 'B',
      validFrom: '2026-03-01',
      source: { vertical: 'rent', eventId: 'evt-b' },
      confidence: 0.9,
    });
    expect(bRes.body.outcome).toBe('SUPERSEDED');
    expect(bRes.body.supersededFactIds).toContain(aRes.body.factId);

    // Operator independently retracts B with a non-supersede reason.
    await f.http
      .post(`/v1/facts/${encodeURIComponent(bRes.body.factId)}/retract`)
      .set(auth())
      .send({
        reason: 'operator-correction',
        retractedBy: { source: 'system' },
      });

    // That retract should have revived A (B superseded A).
    const searchAfterB = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'Revive Chain Tenant status', limit: 5 });
    const objectsAfterB = searchAfterB.body.results
      .flatMap((r: any) => r.facts)
      .map((f: any) => f.object as string);
    expect(objectsAfterB).toContain('A');
  });

  it('natural supersede must NOT set retractedAt (migration 0014 contract)', async () => {
    await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'supersede_contract' },
      predicate: 'name',
      object: 'Supersede Contract',
      validFrom: '2026-01-01',
      source: { vertical: 'rent', eventId: 'auth.created' },
      confidence: 0.95,
    });
    const a = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'supersede_contract' },
      predicate: 'status',
      object: 'first',
      validFrom: '2026-02-01',
      source: { vertical: 'rent', eventId: 'evt-1' },
      confidence: 0.9,
    });
    const aFactId = a.body.factId as string;
    const b = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'supersede_contract' },
      predicate: 'status',
      object: 'second',
      validFrom: '2026-05-01',
      source: { vertical: 'rent', eventId: 'evt-2' },
      confidence: 0.9,
    });
    expect(b.body.outcome).toBe('SUPERSEDED');
    expect(b.body.supersededFactIds).toContain(aFactId);

    // The superseded predecessor: status='superseded', supersededBy set,
    // but retractedAt MUST be NONE — a natural supersede is not a
    // retraction, and setting retractedAt would erase it from asOf
    // slices + emit a spurious timeline 'fact.retracted' event.
    const surreal = f.app.get(SurrealService);
    await surreal.withCompany(f.companyId, async (db) => {
      const tail = aFactId.split(':')[1];
      const [rows] = await db.query<any[][]>(
        `SELECT status, retractedAt, retractionReason, supersededBy
           FROM type::record('knowledge_fact', $tail) LIMIT 1`,
        { tail },
      );
      const row = (rows as any[])[0];
      expect(row.status).toBe('superseded');
      expect(row.retractedAt).toBeFalsy();
      expect(row.supersededBy).toBeTruthy();
      // The revive sentinel is retained (revive + calibration rely on it).
      expect(row.retractionReason).toBe('superseded');
    });

    // Timeline must NOT report the natural supersede as a retraction.
    const timeline = await f.http
      .get('/v1/entities/knowledge_entity:supersede_contract/timeline')
      .set(auth());
    expect(timeline.status).toBe(200);
    const retractedEvents = (timeline.body.events ?? []).filter(
      (e: any) => e.type === 'fact.retracted' && String(e.factId) === aFactId,
    );
    expect(retractedEvents).toHaveLength(0);
  });
});
