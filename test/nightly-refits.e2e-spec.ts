/**
 * Phase 3.5 e2e — manual trigger for the nightly source-trust +
 * calibration refits, verifying that the cron methods actually
 * mutate the SurrealDB tables they advertise.
 *
 * Pure unit tests in calibration-refit.unit-spec.ts already cover the
 * aggregator + correctness predicates; this fills the integration
 * half: real SurrealDB testcontainer, real CalibrationRefitService,
 * real DB row inspection.
 */
import type { AppFixture } from './app-fixture';
import { createApp } from './app-fixture';
import { CalibrationRefitService } from '../src/ai/calibration/calibration-refit.service';
import { SurrealService } from '../src/db/surreal.service';

describe('Phase 3.5 e2e — nightly refits write to SurrealDB', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp();
    // Seed 12 facts so the source-trust aggregator has a useful sample
    // and the calibration collector has enough age-30d rows. Mix
    // active + superseded to give the correctness map non-trivial
    // signal.
    for (let i = 0; i < 12; i++) {
      await f.http
        .post('/v1/ingest/fact')
        .set(auth())
        .send({
          entityRef: { vertical: 'rent', id: `nightly_tenant_${i}` },
          predicate: 'status',
          object: `seed object ${i}`,
          validFrom: '2026-04-01',
          source: { vertical: 'rent', recorder: 'auth.bot', eventId: 'evt' },
          confidence: i % 2 === 0 ? 0.95 : 0.15,
        });
    }
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('refitSourceTrust upserts at least one row', async () => {
    const svc = f.app.get(CalibrationRefitService);
    const upserted = await svc.refitSourceTrust();
    expect(upserted).toBeGreaterThanOrEqual(1);

    const surreal = f.app.get(SurrealService);
    const rows = await surreal.withCompany(f.companyId, async (db) => {
      const [r] = await db.query<
        [Array<{ sourceKey: string; agreementRate: number; sampleCount: number }>]
      >(`SELECT sourceKey, agreementRate, sampleCount FROM source_trust`);
      return r ?? [];
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.sourceKey === 'rent:auth.bot');
    expect(row).toBeDefined();
    expect(row!.sampleCount).toBeGreaterThanOrEqual(1);
    expect(row!.agreementRate).toBeGreaterThanOrEqual(0);
    expect(row!.agreementRate).toBeLessThanOrEqual(1);
  });

  it('refitCalibration is a no-op when sample count is below the threshold', async () => {
    // Default threshold is 40 pairs; we seeded 12, so the refit should
    // skip cleanly and report 0.
    const svc = f.app.get(CalibrationRefitService);
    const sampleCount = await svc.refitCalibration();
    expect(sampleCount).toBe(0);
  });
});
