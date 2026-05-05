/**
 * Unit-test for MetricsService — verifies counters increment, the
 * histogram observes, and the registry serialises to a Prometheus-format
 * payload that includes our domain metrics.
 */
import { MetricsService } from '../src/metrics/metrics.service';

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
    metrics.onModuleInit();
  });

  it('counts ingest outcomes by label', async () => {
    metrics.countIngestFact('INSERTED');
    metrics.countIngestFact('INSERTED');
    metrics.countIngestFact('SUPERSEDED');

    const { body } = await metrics.serialize();
    expect(body).toMatch(/brain_ingest_facts_total\{outcome="INSERTED"\} 2/);
    expect(body).toMatch(/brain_ingest_facts_total\{outcome="SUPERSEDED"\} 1/);
  });

  it('observes search durations into histogram', async () => {
    metrics.observeSearchDuration(0.05);
    metrics.observeSearchDuration(0.2);
    metrics.observeSearchDuration(1.5);

    const { body } = await metrics.serialize();
    // 3 observations recorded
    expect(body).toMatch(/brain_search_duration_seconds_count 3/);
    // Sum should be ≈ 1.75
    const sumMatch = body.match(/brain_search_duration_seconds_sum (\d+\.?\d*)/);
    expect(sumMatch).toBeTruthy();
    expect(parseFloat(sumMatch![1])).toBeCloseTo(1.75, 2);
  });

  it('counts retracts, forgets, compactions', async () => {
    metrics.countRetract();
    metrics.countForget();
    metrics.countForget();
    metrics.countCompacted(42);
    metrics.countCompacted(0); // should be a no-op

    const { body } = await metrics.serialize();
    expect(body).toMatch(/brain_retract_total 1/);
    expect(body).toMatch(/brain_forget_total 2/);
    expect(body).toMatch(/brain_compaction_facts_total 42/);
  });

  it('exposes node default metrics with brain_ prefix', async () => {
    const { body } = await metrics.serialize();
    expect(body).toMatch(/brain_process_/); // process_cpu_user_seconds_total etc.
    expect(body).toMatch(/brain_nodejs_/); // nodejs_eventloop_lag_seconds etc.
  });

  it('emits Prometheus text exposition Content-Type', async () => {
    const { contentType } = await metrics.serialize();
    expect(contentType).toMatch(/text\/plain.*version=0\.0\.4/);
  });

  it('counts ingest mention results', async () => {
    metrics.countIngestMention('extracted');
    metrics.countIngestMention('skipped');
    metrics.countIngestMention('extracted');

    const { body } = await metrics.serialize();
    expect(body).toMatch(/brain_ingest_mentions_total\{result="extracted"\} 2/);
    expect(body).toMatch(/brain_ingest_mentions_total\{result="skipped"\} 1/);
  });
});
