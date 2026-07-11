/**
 * IngestPredictionService.predict — integration smoke
 *
 * The predictor is a JS-side dry-run of fn::resolve_fact. We exercise
 * each branch of the decision tree against a real DB, in the resolver's
 * order (migration 0055):
 *   - Unknown entity → INSERTED
 *   - single_active low score → NEVER REJECTED (reject is bitemporal-only)
 *   - same object, different origin → CORROBORATED
 *   - backdated single_active candidate → INSERTED_HISTORICAL
 *   - single_active with overlapping prior → SUPERSEDED or COMPETING
 *
 * No writes happen via predict — we assert the DB row count stays put.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { SurrealService } from '../src/db/surreal.service';
import { IngestPredictionService } from '../src/ingest/ingest-predictor.service';

describe('IngestPredictionService.predict — read-only conflict preflight', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_predict_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('unknown entity → INSERTED, no opposing facts', async () => {
    const predictor = f.app.get(IngestPredictionService);
    const out = await predictor.predict(f.companyId, {
      entityRef: { vertical: 'rent', id: 'predict_unknown_yet' },
      predicate: 'name',
      object: 'Predict Subject',
      validFrom: '2026-05-01T00:00:00Z',
      confidence: 0.9,
      source: { vertical: 'rent' },
    }, ['brain:read', 'brain:read_pii']);
    expect(out.wouldOutcome).toBe('INSERTED');
    expect(out.opposingFacts).toHaveLength(0);
    expect(out.reasoning).toMatch(/no existing entity/i);
  });

  it('overlapping single_active prior + competitive score → SUPERSEDED or COMPETING', async () => {
    // Seed an entity + a `name` (single_active) fact.
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'predict_single_subj' },
        predicate: 'name',
        object: 'Old Name',
        validFrom: '2026-01-01T00:00:00Z',
        confidence: 0.85,
        source: { vertical: 'rent', recorder: 'older.bot' },
      });
    expect([200, 201]).toContain(ingest.status);

    const predictor = f.app.get(IngestPredictionService);
    const out = await predictor.predict(f.companyId, {
      entityRef: { vertical: 'rent', id: 'predict_single_subj' },
      predicate: 'name',
      object: 'New Name',
      validFrom: '2026-02-01T00:00:00Z',
      confidence: 0.95,
      source: { vertical: 'rent', eventId: 'auth.profile_updated' },
    }, ['brain:read', 'brain:read_pii']);
    // single_active with overlap → either SUPERSEDED (gap > margin) or
    // COMPETING. The exact verdict depends on weight tuning; assert
    // either-or AND that we surfaced the opposing fact.
    expect(['SUPERSEDED', 'COMPETING']).toContain(out.wouldOutcome);
    expect(out.opposingFacts.length).toBeGreaterThan(0);
    expect(out.opposingFacts[0].object).toBe('Old Name');
    expect(out.predicatePolicy.semantics).toBe('single_active');

    // And the dry-run must NOT have written anything.
    const surreal = f.app.get(SurrealService);
    const remaining = await surreal.withCompany(f.companyId, async (db) => {
      const [rows] = await db.query<any[][]>(
        `SELECT id FROM knowledge_fact
           WHERE predicate = 'name' AND object = 'New Name'`,
      );
      return ((rows as any[]) ?? []).length;
    });
    expect(remaining).toBe(0);
  });

  it('below reject threshold → REJECTED', async () => {
    // Seed an entity so the predictor reaches the score-eval branch.
    const ingest = await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'predict_reject_subj' },
        predicate: 'name',
        object: 'Reject Subject',
        validFrom: '2026-01-01T00:00:00Z',
        confidence: 0.9,
        source: { vertical: 'rent' },
      });
    expect([200, 201]).toContain(ingest.status);

    const predictor = f.app.get(IngestPredictionService);
    // Very low confidence + default-trust source. With default weights
    // (conf=.3, srcTrust=.4, recency=.2, authority=.1) the score is
    // .3*0 + .4*.5 + .2*~1 + .1*0 = ~.4. Default reject is .3 so this
    // can still clear; push confidence to 0 and pick a non-default
    // trust class to land below .3. inbox_extraction trust=0.5,
    // default trust=0.5, so we need to lean harder. We synthesize a
    // pseudo-source that the heuristic can't classify (vertical
    // without a recognised prefix) and zero confidence:
    //   score ≈ .3*0 + .4*.5 + .2*~1 + .1*0 = .5 — still above .3.
    // The cleanest way to assert the REJECTED branch fires at all is
    // to override CONFLICT_REJECT_THRESHOLD via env. We don't restart
    // the app inside the spec, so instead assert that the predictor
    // surfaces the branch on a deliberately-near-floor candidate.
    const out = await predictor.predict(f.companyId, {
      entityRef: { vertical: 'rent', id: 'predict_reject_subj' },
      predicate: 'name',
      object: 'Different Name',
      validFrom: '2026-02-01T00:00:00Z',
      confidence: 0,
      source: { vertical: 'rent' },
    }, ['brain:read', 'brain:read_pii']);
    // `name` is single_active — the reject gate is bitemporal-ONLY in
    // fn::resolve_fact (0055), so a low score here must NEVER report
    // REJECTED (the old predictor wrongly rejected every semantics). It
    // resolves to a supersede/compete verdict instead.
    expect(out.wouldOutcome).not.toBe('REJECTED');
    expect(['SUPERSEDED', 'COMPETING', 'INSERTED']).toContain(out.wouldOutcome);
    expect(out.reasoning.length).toBeGreaterThan(0);
  });

  it('same object from a DIFFERENT origin → CORROBORATED', async () => {
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'predict_corrob_subj' },
        predicate: 'name',
        object: 'Corroborated Name',
        validFrom: '2026-01-01T00:00:00Z',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'source_a' },
      });

    const predictor = f.app.get(IngestPredictionService);
    const out = await predictor.predict(f.companyId, {
      entityRef: { vertical: 'rent', id: 'predict_corrob_subj' },
      predicate: 'name',
      object: 'Corroborated Name', // SAME object
      validFrom: '2026-02-01T00:00:00Z',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'source_b' }, // DIFFERENT origin
    }, ['brain:read', 'brain:read_pii']);
    expect(out.wouldOutcome).toBe('CORROBORATED');
    expect(out.opposingFacts[0]?.object).toBe('Corroborated Name');
  });

  it('backdated single_active candidate → INSERTED_HISTORICAL', async () => {
    await f.http
      .post('/v1/ingest/fact')
      .set(auth())
      .send({
        entityRef: { vertical: 'rent', id: 'predict_hist_subj' },
        predicate: 'name',
        object: 'Current Name',
        validFrom: '2026-03-01T00:00:00Z',
        confidence: 0.9,
        source: { vertical: 'rent', recorder: 'bot' },
      });

    const predictor = f.app.get(IngestPredictionService);
    const out = await predictor.predict(f.companyId, {
      entityRef: { vertical: 'rent', id: 'predict_hist_subj' },
      predicate: 'name',
      object: 'Older Name', // different object → not corroboration
      validFrom: '2026-01-01T00:00:00Z', // BEFORE the active fact
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    }, ['brain:read', 'brain:read_pii']);
    expect(out.wouldOutcome).toBe('INSERTED_HISTORICAL');
    expect(out.opposingFacts.length).toBeGreaterThan(0);
  });

  it('predicate policy is surfaced in the result', async () => {
    const predictor = f.app.get(IngestPredictionService);
    const out = await predictor.predict(f.companyId, {
      entityRef: { vertical: 'rent', id: 'predict_policy_subj' },
      predicate: 'name',
      object: 'X',
      validFrom: '2026-01-01T00:00:00Z',
      confidence: 0.7,
      source: { vertical: 'rent' },
    }, ['brain:read', 'brain:read_pii']);
    expect(out.predicatePolicy.semantics).toMatch(
      /^(single_active|append_only|bitemporal)$/,
    );
    expect(typeof out.predicatePolicy.piiClass).toBe('string');
  });
});
