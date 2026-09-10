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

  /**
   * The payload with the per-replica `instance` default label stripped, so
   * the assertions below read each metric's OWN labels. That the label is
   * there at all is asserted separately.
   */
  async function payload(): Promise<string> {
    const { body } = await metrics.serialize();
    // Counters/gauges append it, histograms prepend it.
    return body
      .replace(/,instance="[^"]*"/g, '')
      .replace(/\{instance="[^"]*",/g, '{')
      .replace(/\{instance="[^"]*"\}/g, '');
  }

  it('counts ingest outcomes by label', async () => {
    metrics.countIngestFact('INSERTED');
    metrics.countIngestFact('INSERTED');
    metrics.countIngestFact('SUPERSEDED');

    const body = await payload();
    expect(body).toMatch(/brain_ingest_facts_total\{outcome="INSERTED"\} 2/);
    expect(body).toMatch(/brain_ingest_facts_total\{outcome="SUPERSEDED"\} 1/);
  });

  it('observes search durations into histogram', async () => {
    metrics.observeSearchDuration(0.05);
    metrics.observeSearchDuration(0.2);
    metrics.observeSearchDuration(1.5);

    const body = await payload();
    // 3 observations recorded
    expect(body).toMatch(/brain_search_duration_seconds_count 3/);
    // Sum should be ≈ 1.75
    const sumMatch = body.match(/brain_search_duration_seconds_sum (\d+\.?\d*)/);
    expect(sumMatch).toBeTruthy();
    expect(parseFloat(sumMatch![1]!)).toBeCloseTo(1.75, 2);
  });

  it('counts retracts, forgets, compactions', async () => {
    metrics.countRetract();
    metrics.countForget();
    metrics.countForget();
    metrics.countCompacted(42);
    metrics.countCompacted(0); // should be a no-op

    const body = await payload();
    expect(body).toMatch(/brain_retract_total 1/);
    expect(body).toMatch(/brain_forget_total 2/);
    expect(body).toMatch(/brain_compaction_facts_total 42/);
  });

  it('exposes node default metrics with brain_ prefix', async () => {
    const body = await payload();
    expect(body).toMatch(/brain_process_/); // process_cpu_user_seconds_total etc.
    expect(body).toMatch(/brain_nodejs_/); // nodejs_eventloop_lag_seconds etc.
  });

  it('emits Prometheus text exposition Content-Type', async () => {
    const { contentType } = await metrics.serialize();
    expect(contentType).toMatch(/text\/plain.*version=0\.0\.4/);
  });

  it('records OpenAI call counters, durations, and tokens', async () => {
    metrics.recordOpenAiCall({
      kind: 'embed',
      outcome: 'ok',
      durationSeconds: 0.4,
      promptTokens: 12,
      completionTokens: 0,
    });
    metrics.recordOpenAiCall({
      kind: 'chat',
      outcome: 'ok',
      durationSeconds: 1.7,
      promptTokens: 320,
      completionTokens: 88,
    });
    metrics.recordOpenAiCall({
      kind: 'chat',
      outcome: 'error',
      durationSeconds: 5.2,
    });

    const body = await payload();
    expect(body).toMatch(/brain_openai_calls_total\{kind="embed",outcome="ok"\} 1/);
    expect(body).toMatch(/brain_openai_calls_total\{kind="chat",outcome="ok"\} 1/);
    expect(body).toMatch(/brain_openai_calls_total\{kind="chat",outcome="error"\} 1/);
    expect(body).toMatch(/brain_openai_tokens_total\{kind="embed",type="prompt"\} 12/);
    expect(body).toMatch(/brain_openai_tokens_total\{kind="chat",type="prompt"\} 320/);
    expect(body).toMatch(/brain_openai_tokens_total\{kind="chat",type="completion"\} 88/);
    // Histogram observations recorded
    expect(body).toMatch(/brain_openai_call_duration_seconds_count\{kind="embed"\} 1/);
    expect(body).toMatch(/brain_openai_call_duration_seconds_count\{kind="chat"\} 2/);
  });

  it('does not emit a token counter when count is 0 or undefined', async () => {
    metrics.recordOpenAiCall({
      kind: 'embed',
      outcome: 'ok',
      durationSeconds: 0.1,
      promptTokens: 0,
    });
    const body = await payload();
    expect(body).not.toMatch(/brain_openai_tokens_total\{[^}]*kind="embed"/);
  });

  it('counts ingest mention results', async () => {
    metrics.countIngestMention('extracted');
    metrics.countIngestMention('skipped');
    metrics.countIngestMention('extracted');

    const body = await payload();
    expect(body).toMatch(/brain_ingest_mentions_total\{result="extracted"\} 2/);
    expect(body).toMatch(/brain_ingest_mentions_total\{result="skipped"\} 1/);
  });

  it('counts L3 escalation outcomes by label (G2)', async () => {
    metrics.countL3Escalation('fired');
    metrics.countL3Escalation('fired');
    metrics.countL3Escalation('flipped');
    metrics.countL3Escalation('no_flip');
    metrics.countL3Escalation('skipped_no_anchor');
    metrics.countL3Escalation('over_budget_degraded');

    const body = await payload();
    expect(body).toMatch(/brain_l3_escalation_total\{outcome="fired"\} 2/);
    expect(body).toMatch(/brain_l3_escalation_total\{outcome="flipped"\} 1/);
    expect(body).toMatch(/brain_l3_escalation_total\{outcome="no_flip"\} 1/);
    expect(body).toMatch(/brain_l3_escalation_total\{outcome="skipped_no_anchor"\} 1/);
    expect(body).toMatch(/brain_l3_escalation_total\{outcome="over_budget_degraded"\} 1/);
  });

  it('counts ingest write attempts by surface path (G9 write-anomaly)', async () => {
    metrics.countIngestWrite('mention');
    metrics.countIngestWrite('mention');
    metrics.countIngestWrite('fact');
    metrics.countIngestWrite('document');
    metrics.countIngestWrite('candidate');
    metrics.countIngestWrite('mcp');

    const body = await payload();
    expect(body).toMatch(/brain_ingest_writes_total\{path="mention"\} 2/);
    expect(body).toMatch(/brain_ingest_writes_total\{path="fact"\} 1/);
    expect(body).toMatch(/brain_ingest_writes_total\{path="document"\} 1/);
    expect(body).toMatch(/brain_ingest_writes_total\{path="candidate"\} 1/);
    expect(body).toMatch(/brain_ingest_writes_total\{path="mcp"\} 1/);
  });

  describe('per-replica identity', () => {
    it('labels every series with the replica that produced it', async () => {
      // N replicas otherwise serialise indistinguishable payloads, and a
      // scrape read straight off /metrics cannot say whose numbers it has.
      metrics.countIngestFact('INSERTED');
      const { body } = await metrics.serialize();
      expect(body).toMatch(/brain_ingest_facts_total\{outcome="INSERTED",instance="[^"]+"\} 1/);
    });

    it('publishes no boot zero for gauges only the lease holder writes', async () => {
      // prom-client publishes a label-less gauge as 0 from construction,
      // so every non-leader replica exported a confident "0 pending" it had
      // never measured — and max()/avg() over replicas read it as fact.
      const { body } = await metrics.serialize();
      for (const name of [
        'brain_changefeed_lag_records',
        'brain_vector_corpus_tenants_nonconforming',
        'brain_memory_orphan_entities',
        'brain_policy_sets_active',
      ]) {
        expect(body).not.toMatch(new RegExp(`^${name}\\{`, 'm'));
      }
    });

    it('publishes the gauge again once this replica measures something', async () => {
      metrics.setChangefeedLag(7);
      const body = await payload();
      expect(body).toMatch(/brain_changefeed_lag_records 7/);
    });

    it('still reports worker_is_leader on a non-leader — 0 is a measurement there', async () => {
      // Deliberate exception: sum() across replicas is how the
      // NoWorkerLeader alert counts leaders, so "I am not it" must be said
      // out loud rather than left absent.
      const body = await payload();
      expect(body).toMatch(/brain_worker_is_leader 0/);
    });
  });
});
