/**
 * e2e for the source-reputation track, Phase 4 (migration 0047):
 * cross-source agreement strengthens instead of dueling.
 *
 *   1. The same claim (exact object) from a DIFFERENT source →
 *      CORROBORATED: new row kept as a `corroborating` audit record,
 *      incumbent accumulates {count, sourceKeys[], lastAt}.
 *   2. Works for single_active too — a confirming source does NOT churn
 *      the timeline (no supersede of an identical value).
 *   3. Corroborating rows are hidden from search + entity reads (the
 *      incumbent carries the fact); no duplicate results.
 *   4. Retracting the incumbent leaves corroborating rows untouched
 *      (accepted v1 semantics — they are records of claims).
 *   5. The nightly refit counts a corroborating row as a WIN for its
 *      source.
 */
import { Surreal } from 'surrealdb';
import { SurrealService } from '../src/db/surreal.service';
import { CalibrationRefitRunnerService } from '../src/ai/calibration/calibration-refit-runner.service';
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';

const ALPHA = { vertical: 'ops', recorder: 'scout_alpha' };
const BRAVO = { vertical: 'ops', recorder: 'scout_bravo' };
const CHARLIE = { vertical: 'ops', recorder: 'scout_charlie' };

describe('cross-source corroboration (Phase 4)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  const withDb = async <T>(fn: (db: Surreal) => Promise<T>) =>
    f.app.get(SurrealService).withCompany(f.companyId, fn);

  const factRow = async (factId: string) =>
    withDb(async (db) => {
      const [rows] = await db.query<[any[]]>(`SELECT * FROM type::record('knowledge_fact', $rid)`, {
        rid: factId.split(':')[1],
      });
      return (rows as any[])?.[0];
    });

  const ingest = (opts: { entityId: string; predicate: string; object: string; source: object }) =>
    f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'ops', id: opts.entityId },
        predicate: opts.predicate,
        object: opts.object,
        validFrom: '2026-06-01T00:00:00Z',
        source: opts.source,
        confidence: 0.9,
      });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_corroboration_e2e' });
    await f.http.post('/v1/admin/predicates').set(auth()).send({
      predicateId: 'sighting',
      semantics: 'bitemporal',
      piiClass: 'none',
      description: 'e2e: bitemporal corroboration playground',
    });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('a second and third source corroborate instead of dueling', async () => {
    const OBJ = 'crane on the north lot';
    const first = await ingest({
      entityId: 'site_42',
      predicate: 'sighting',
      object: OBJ,
      source: ALPHA,
    });
    expect(first.body.outcome).toBe('INSERTED');

    const second = await ingest({
      entityId: 'site_42',
      predicate: 'sighting',
      object: OBJ,
      source: BRAVO,
    });
    expect(second.body.outcome).toBe('CORROBORATED');
    expect(String(second.body.corroboratedFactId)).toBe(first.body.factId);

    const third = await ingest({
      entityId: 'site_42',
      predicate: 'sighting',
      object: OBJ,
      source: CHARLIE,
    });
    expect(third.body.outcome).toBe('CORROBORATED');

    // The corroborating row is a linked audit record...
    const bravoRow = await factRow(second.body.factId);
    expect(bravoRow.status).toBe('corroborating');
    expect(String(bravoRow.corroborates)).toBe(first.body.factId);

    // ...and the incumbent accumulated the independent confirmations.
    const incumbent = await factRow(first.body.factId);
    expect(incumbent.status).toBe('active');
    expect(incumbent.corroboration.count).toBe(2);
    expect(incumbent.corroboration.sourceKeys.sort()).toEqual([
      'ops:scout_bravo',
      'ops:scout_charlie',
    ]);
    expect(incumbent.corroboration.lastAt).toBeDefined();
  });

  it('confirming an identical single_active value does not churn the timeline', async () => {
    const first = await ingest({
      entityId: 'site_43',
      predicate: 'status',
      object: 'operational',
      source: ALPHA,
    });
    expect(first.body.outcome).toBe('INSERTED');

    // Pre-0047 this superseded the identical incumbent (pointless churn:
    // new fact id, closed interval, same value). Now it confirms.
    const second = await ingest({
      entityId: 'site_43',
      predicate: 'status',
      object: 'operational',
      source: BRAVO,
    });
    expect(second.body.outcome).toBe('CORROBORATED');

    // A DIFFERENT value from another source still supersedes as before.
    const change = await ingest({
      entityId: 'site_43',
      predicate: 'status',
      object: 'shut down',
      source: BRAVO,
    });
    expect(change.body.outcome).toBe('SUPERSEDED');
  });

  it('hides corroborating rows from search and entity reads (no duplicates)', async () => {
    const search = await f.http
      .post('/v1/search')
      .set(auth())
      .send({ query: 'crane on the north lot', limit: 10 });
    expect(search.status).toBe(201);
    const matches = search.body.results
      .flatMap((r: any) => r.facts)
      .filter((x: any) => x.object === 'crane on the north lot');
    expect(matches).toHaveLength(1);
  });

  it('retracting the incumbent leaves corroborating rows untouched (v1 semantics)', async () => {
    const OBJ = 'fence breached on east side';
    const first = await ingest({
      entityId: 'site_44',
      predicate: 'sighting',
      object: OBJ,
      source: ALPHA,
    });
    const second = await ingest({
      entityId: 'site_44',
      predicate: 'sighting',
      object: OBJ,
      source: BRAVO,
    });
    expect(second.body.outcome).toBe('CORROBORATED');

    const retract = await f.http
      .post(`/v1/facts/${encodeURIComponent(first.body.factId)}/retract`)
      .set(auth())
      .send({ reason: 'false alarm', retractedBy: { source: 'human' } });
    expect(retract.status).toBe(201);

    const bravoRow = await factRow(second.body.factId);
    expect(bravoRow.status).toBe('corroborating');
    expect(bravoRow.retractedAt).toBeUndefined();
  });

  it('the refit counts corroborating rows as wins for their source', async () => {
    await f.app.get(CalibrationRefitRunnerService).refitSourceTrust();
    const rows = await withDb(async (db) => {
      const [r] = await db.query<[any[]]>(
        `SELECT domain, winCount, lossCount FROM source_trust
           WHERE sourceKey = 'ops:scout_bravo' AND domain IS NONE`,
      );
      return r as any[];
    });
    expect(rows).toHaveLength(1);
    // bravo produced only corroborating rows (+1 superseded 'shut down'
    // supersede-winner is ALPHA's loss, not bravo's) — wins must be > 0.
    expect(rows[0].winCount).toBeGreaterThanOrEqual(2);
  });
});
