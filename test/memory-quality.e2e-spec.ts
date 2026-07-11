/**
 * Memory-quality nightly pass against a REAL SurrealDB — regression for
 * the `duration::from::days` 2.x idiom that SurrealDB 3.x fails to parse
 * ("did you maybe mean `duration::from_days`"). Every tenant threw on the
 * stale-bucket loop, so the nightly cron published all-zero gauges (and
 * the collateral brain_policy_sets_active never ran). The unit spec mocks
 * the DB, so only a real-DB pass catches the parse error.
 */
import { AppFixture, createApp } from './app-fixture';
import { MemoryQualityService } from '../src/metrics/memory-quality.service';

describe('memory-quality nightly pass (real SurrealDB)', () => {
  let f: AppFixture;
  const auth = () => ({ Authorization: `Bearer ${f.apiKey}` });

  beforeAll(async () => {
    f = await createApp({ companyId: 'co_memquality_e2e' });
  });

  afterAll(async () => {
    if (f) await f.close();
  });

  it('collects gauges without throwing on the stale-bucket duration query', async () => {
    const ingest = await f.http.post('/v1/ingest/fact').set(auth()).send({
      entityRef: { vertical: 'rent', id: 'memquality_subject' },
      predicate: 'name',
      object: 'Memory Quality Probe',
      validFrom: '2026-01-01',
      confidence: 0.9,
      source: { vertical: 'rent', recorder: 'bot' },
    });
    expect([200, 201]).toContain(ingest.status);

    const svc = f.app.get(MemoryQualityService);
    // Pre-fix this threw a parse error inside collectTenant → the tenant
    // was skipped and every gauge fell to 0. Post-fix the query parses and
    // the active fact we just ingested is counted.
    const snapshot = await svc.collectNow();

    expect(snapshot.factsByStatus['active']).toBeGreaterThanOrEqual(1);
    // Stale buckets must be present (all three keys populated, not skipped).
    expect(Object.keys(snapshot.staleActiveFacts).sort()).toEqual([
      '30',
      '365',
      '90',
    ]);
    // A freshly ingested fact is not stale at any horizon.
    expect(snapshot.staleActiveFacts[30]).toBe(0);
  });
});
