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
 *   - search_rerank_total{outcome}            — invoked|skipped_disabled|skipped_singleton|skipped_margin
 *   - search_cross_encoder_total{outcome}     — invoked|error|skipped_disabled|skipped_singleton
 *   - synthesize_total{outcome}               — ok|no_results|no_grounded_evidence|verifier_partial|verifier_failed|generator_error|verifier_error
 *   - multi_hop_total{outcome}                — ok|single_hop|chain_empty|no_results|planner_error|hop_error
 *   - dreams_total{outcome}                   — ok|failed
 *   - dreams_emitted_total{kind}              — identity_link|resolution|summary
 *   - retract_total / forget_total            — counters
 *   - compaction_facts_total                  — counter, summed across tenants
 *   - openai_tokens_total{kind, type}         — embed|chat × prompt|completion
 *   - openai_calls_total{kind, outcome}       — embed|chat × ok|error
 *   - openai_call_duration_seconds{kind}      — histogram per kind
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

  // Outcomes:
  //   invoked          — reranker actually ran on the candidate set
  //   skipped_disabled — SEARCH_RERANKER_ENABLED=0 or no OpenAI key
  //   skipped_singleton— ≤1 candidate after fusion, nothing to reorder
  //   skipped_margin   — top-1 vs top-2 fused-score gap exceeded
  //                      SEARCH_RERANK_SKIP_MARGIN; the leader is
  //                      strong enough that the LLM call is unlikely
  //                      to change the top-K. Tracks the cost saving.
  readonly searchRerankCount = new Counter({
    name: 'brain_search_rerank_total',
    help: 'Search reranker invocations by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Dreams outcomes (per-tenant cron + manual trigger):
  //   ok      — tenant pass completed (may have done zero work; the
  //             emitted-counter tells you what landed)
  //   failed  — sub-service threw, tenant skipped
  // The brain_dreams_emitted counter splits by KIND of artefact
  // produced (identity_link / resolution / summary). Watch the
  // ratio against ok-runs to see whether dreams is doing anything
  // useful or just spinning.
  readonly dreamsCount = new Counter({
    name: 'brain_dreams_total',
    help: 'Dreams pass invocations by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly dreamsEmitted = new Counter({
    name: 'brain_dreams_emitted_total',
    help: 'Dreams artefacts emitted by kind',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  // Multi-hop outcomes:
  //   ok             — chain ran end-to-end with a non-empty final set
  //   single_hop     — planner reported isMultiHop=false; one hop only
  //   chain_empty    — combination produced an empty running set; the
  //                    chain terminated early (saved later hops' cost)
  //   no_results     — first hop returned zero hits
  //   planner_error  — planner LLM failed; fell back to single-shot
  //   hop_error      — a hop's search threw; chain stopped, partial
  //                    response returned with what we had
  // The (planner_error + hop_error) ratio tracks the chain's
  // reliability against the upstream OpenAI / Surreal health.
  readonly multiHopCount = new Counter({
    name: 'brain_multi_hop_total',
    help: 'Multi-hop search invocations by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Synthesize outcomes:
  //   ok                   — answer returned, supported (or guardrails=off)
  //   no_results           — search returned zero hits
  //   no_grounded_evidence — generator emitted the "I don't know" sentinel
  //   verifier_partial     — verifier flagged paraphrased / inferred claims
  //   verifier_failed      — verifier flagged unsupported claims
  //   generator_error      — LLM generator call failed (returned closed-fail)
  //   verifier_error       — LLM verifier call failed (strict ⇒ closed-fail)
  // The error-counter ratio against ok/no_results tells the operator
  // whether the synthesizer is healthy or upstream OpenAI is flaky.
  readonly synthesizeCount = new Counter({
    name: 'brain_synthesize_total',
    help: 'Synthesize endpoint invocations by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Cross-encoder outcomes:
  //   invoked          — Cohere call returned a non-identity permutation
  //   error            — Cohere fallback to identity (timeout / 4xx / 5xx)
  //   skipped_disabled — SEARCH_CROSS_ENCODER_ENABLED=0 or no Cohere key
  //   skipped_singleton— ≤1 candidate, nothing to reorder
  // The error vs invoked split is what tells the operator whether the
  // cross-encoder is actually doing work or silently degrading.
  readonly searchCrossEncoderCount = new Counter({
    name: 'brain_search_cross_encoder_total',
    help: 'Cross-encoder invocations by outcome',
    labelNames: ['outcome'] as const,
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

  readonly openaiTokens = new Counter({
    name: 'brain_openai_tokens_total',
    help: 'OpenAI tokens consumed, by call kind and token type',
    labelNames: ['kind', 'type'] as const,
    registers: [this.registry],
  });

  readonly openaiCalls = new Counter({
    name: 'brain_openai_calls_total',
    help: 'OpenAI API calls by kind and outcome',
    labelNames: ['kind', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly openaiCallDuration = new Histogram({
    name: 'brain_openai_call_duration_seconds',
    help: 'OpenAI API call latency in seconds, by kind',
    labelNames: ['kind'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
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

  countRerank(
    outcome:
      | 'invoked'
      | 'skipped_disabled'
      | 'skipped_singleton'
      | 'skipped_margin',
  ): void {
    this.searchRerankCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countCrossEncoder(
    outcome:
      | 'invoked'
      | 'error'
      | 'skipped_disabled'
      | 'skipped_singleton',
  ): void {
    this.searchCrossEncoderCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countDreams(outcome: 'ok' | 'failed'): void {
    this.dreamsCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countDreamsEmitted(
    kind: 'identity_link' | 'resolution' | 'summary',
    n = 1,
  ): void {
    if (n > 0) {
      this.dreamsEmitted.inc({ kind } as LabelValues<'kind'>, n);
    }
  }

  countMultiHop(
    outcome:
      | 'ok'
      | 'single_hop'
      | 'chain_empty'
      | 'no_results'
      | 'planner_error'
      | 'hop_error',
  ): void {
    this.multiHopCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countSynthesize(
    outcome:
      | 'ok'
      | 'no_results'
      | 'no_grounded_evidence'
      | 'verifier_partial'
      | 'verifier_failed'
      | 'generator_error'
      | 'verifier_error',
  ): void {
    this.synthesizeCount.inc({ outcome } as LabelValues<'outcome'>);
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

  /**
   * Record an OpenAI call. Pass token counts as reported by the SDK
   * (`response.usage.prompt_tokens` / `completion_tokens`). For embeddings
   * the API returns `prompt_tokens` only; pass 0 for completion.
   */
  recordOpenAiCall(args: {
    kind: 'embed' | 'chat';
    outcome: 'ok' | 'error';
    durationSeconds: number;
    promptTokens?: number;
    completionTokens?: number;
  }): void {
    this.openaiCalls.inc({ kind: args.kind, outcome: args.outcome } as LabelValues<
      'kind' | 'outcome'
    >);
    this.openaiCallDuration.observe(
      { kind: args.kind } as LabelValues<'kind'>,
      args.durationSeconds,
    );
    if (args.promptTokens && args.promptTokens > 0) {
      this.openaiTokens.inc(
        { kind: args.kind, type: 'prompt' } as LabelValues<'kind' | 'type'>,
        args.promptTokens,
      );
    }
    if (args.completionTokens && args.completionTokens > 0) {
      this.openaiTokens.inc(
        { kind: args.kind, type: 'completion' } as LabelValues<'kind' | 'type'>,
        args.completionTokens,
      );
    }
  }

  async serialize(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
