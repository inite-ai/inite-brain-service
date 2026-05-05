import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from 'prom-client';

/**
 * MetricsService — owns the Prometheus registry for the brain.
 *
 * One registry per process, exposed via /metrics. Default node metrics
 * (process_*, nodejs_*) are enabled so ops gets RSS/heap/event-loop lag
 * for free. Domain metrics are minimal and bounded by label cardinality:
 *
 *   - ingest_facts_total{outcome}             — INSERTED|SUPERSEDED|COMPETING|REJECTED
 *   - ingest_mentions_total{result}           — extracted|skipped|failed
 *   - search_duration_seconds                 — histogram, buckets tuned for ~ms-to-1s
 *   - retract_total / forget_total            — counters
 *   - compaction_facts_total                  — counter, summed across tenants
 *
 * No `companyId` label — that would be unbounded cardinality. Per-tenant
 * dashboards are built off log lines (which carry companyId) instead.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly ingestFacts = new Counter({
    name: 'brain_ingest_facts_total',
    help: 'Number of fact ingests by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly ingestMentions = new Counter({
    name: 'brain_ingest_mentions_total',
    help: 'Number of mention ingests by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly searchDuration = new Histogram({
    name: 'brain_search_duration_seconds',
    help: 'Search latency in seconds',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  readonly retracts = new Counter({
    name: 'brain_retract_total',
    help: 'Number of fact retractions',
    registers: [this.registry],
  });

  readonly forgets = new Counter({
    name: 'brain_forget_total',
    help: 'Number of entity forgets (cascade)',
    registers: [this.registry],
  });

  readonly compactionFacts = new Counter({
    name: 'brain_compaction_facts_total',
    help: 'Number of facts compacted (sum across tenants)',
    registers: [this.registry],
  });

  onModuleInit() {
    // Node defaults: GC, event-loop lag, memory, CPU. Cheap and useful.
    collectDefaultMetrics({ register: this.registry, prefix: 'brain_' });
  }

  countIngestFact(outcome: string): void {
    this.ingestFacts.inc({ outcome } as LabelValues<'outcome'>);
  }

  countIngestMention(result: string): void {
    this.ingestMentions.inc({ result } as LabelValues<'result'>);
  }

  observeSearchDuration(seconds: number): void {
    this.searchDuration.observe(seconds);
  }

  countRetract(): void {
    this.retracts.inc();
  }

  countForget(): void {
    this.forgets.inc();
  }

  countCompacted(n: number): void {
    if (n > 0) this.compactionFacts.inc(n);
  }

  async serialize(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
