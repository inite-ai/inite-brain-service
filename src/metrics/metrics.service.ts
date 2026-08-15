import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from 'prom-client';

/** knowledge_fact.status enum (schema ASSERT) — every value gets a series. */
export const FACT_STATUSES = [
  'active',
  'competing',
  'retracted',
  'superseded',
  'compacted',
  'corroborating',
] as const;

/** Age buckets for the stale-active-facts gauge, in days. */
export const STALE_BUCKETS_DAYS = [30, 90, 365] as const;

/** Aggregate computed by MemoryQualityService across all tenants. */
export interface MemoryQualitySnapshot {
  factsByStatus: Record<string, number>;
  staleActiveFacts: Record<number, number>;
  trustBands: { low: number; neutral: number; high: number };
  orphanEntities: number;
  policySetsActive: number;
}

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
 *   - search_rerank_total{outcome}            — invoked|error|skipped_disabled|skipped_singleton|skipped_margin
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
 *   - memory_facts{status}                    — nightly snapshot gauges
 *   - memory_stale_active_facts{older_than_days}  (MemoryQualityService,
 *   - memory_fact_trust{band}                     03:35 UTC, sum across
 *   - memory_orphan_entities                      tenants)
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
  //   skipped_disabled — no OpenAI client configured
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
  //   skipped_disabled — neither Cohere key nor local provider available
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

  readonly promotionFacts = new Counter({
    name: 'brain_promotion_facts_total',
    help: 'Number of active facts folded into promotion summaries (sum across tenants)',
    registers: [this.registry],
  });

  readonly feedbackCount = new Counter({
    name: 'brain_feedback_total',
    help: 'Retrieval feedback verdicts recorded',
    labelNames: ['verdict'] as const,
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

  readonly changefeedConsumed = new Counter({
    name: 'brain_changefeed_consumed_total',
    help: 'CHANGEFEED records consumed into audit_event by source table',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly changefeedLag = new Gauge({
    name: 'brain_changefeed_lag_records',
    help: 'CHANGEFEED records pending after the most recent consumer tick (sum across tenants/tables)',
    registers: [this.registry],
  });

  // Memory-quality snapshot gauges — replaced wholesale by the nightly
  // MemoryQualityService pass (03:35 UTC), summed across tenants. Every
  // label value is written on every pass (absent buckets set to 0), so
  // no stale series linger between passes. These are the alertable
  // "is the memory rotting" signals: a growing competing backlog, an
  // ageing active set, a drift toward low-trust sources, entities with
  // no memory left attached.
  readonly memoryFacts = new Gauge({
    name: 'brain_memory_facts',
    help: 'Snapshot count of knowledge_fact rows by status (sum across tenants)',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  readonly memoryStaleActiveFacts = new Gauge({
    name: 'brain_memory_stale_active_facts',
    help: 'Snapshot count of active facts recorded more than N days ago (sum across tenants)',
    labelNames: ['older_than_days'] as const,
    registers: [this.registry],
  });

  readonly memoryFactTrust = new Gauge({
    name: 'brain_memory_fact_trust',
    help: 'Snapshot count of active facts by source-reputation band: low (<0.4), neutral, high (>0.6)',
    labelNames: ['band'] as const,
    registers: [this.registry],
  });

  readonly memoryOrphanEntities = new Gauge({
    name: 'brain_memory_orphan_entities',
    help: 'Snapshot count of unmerged entities with zero active facts (sum across tenants)',
    registers: [this.registry],
  });

  // Background job execution. Before this, job outcomes lived only on
  // OTel spans + logs — there was no Prometheus signal to alert on a
  // rising failure rate or a stalled queue. Outcomes mirror the span's
  // `job.outcome`: succeeded | failed | cancelled | lost_claim.
  readonly jobsTotal = new Counter({
    name: 'brain_job_total',
    help: 'Background job dispatches by type and terminal outcome',
    labelNames: ['jobType', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly jobDuration = new Histogram({
    name: 'brain_job_duration_seconds',
    help: 'Background job handler latency in seconds, by type',
    labelNames: ['jobType'] as const,
    buckets: [0.05, 0.25, 1, 5, 15, 60, 300, 1200],
    registers: [this.registry],
  });

  // 1 on the pod currently holding the worker_loop leader lease, 0
  // elsewhere. Summed across pods it tells the operator whether the
  // cluster has exactly one leader (sum=1), none (sum=0 → no jobs
  // running), or a split-brain window (sum>1).
  readonly workerIsLeader = new Gauge({
    name: 'brain_worker_is_leader',
    help: 'Whether this pod currently holds the worker_loop leader lease (1/0)',
    registers: [this.registry],
  });

  // In-flight job dispatches per jobType. Only reported by the bounded-
  // concurrency poll loop (WORKER_LOOP_MAX_CONCURRENT[_<JOBTYPE>] > 1 or
  // WORKER_LOOP_GLOBAL_MAX_CONCURRENT > 0); the default serial loop keeps
  // its original code path and emits nothing here.
  readonly workerJobsInFlight = new Gauge({
    name: 'brain_worker_jobs_in_flight',
    help: 'In-flight background job dispatches, by jobType',
    labelNames: ['jobType'] as const,
    registers: [this.registry],
  });

  // Document ingest (Source → Indexer → Candidates → Brain). No packId
  // label anywhere here — tenant-installed pack ids are unbounded
  // cardinality; per-pack stats live on indexer_run.stats rows.
  //   documents: created | deduplicated | failed
  //   indexer runs: succeeded | failed | skipped_duplicate
  //   candidates: {kind × decision} — created | committed | merged |
  //               rejected | expired; commit/merge/reject RATES are
  //               ratios of this counter.
  //   commit memory: ok | noop | failed
  readonly documentsCount = new Counter({
    name: 'brain_documents_total',
    help: 'Document ingests by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly indexerRunsCount = new Counter({
    name: 'brain_indexer_runs_total',
    help: 'Indexer runs by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly candidatesCount = new Counter({
    name: 'brain_candidates_total',
    help: 'Candidate rows by kind and decision',
    labelNames: ['kind', 'decision'] as const,
    registers: [this.registry],
  });

  readonly commitMemoryCount = new Counter({
    name: 'brain_commit_memory_total',
    help: 'CommitMemory (Brain step) invocations by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // ABAC (policy module). decision: allow | deny | would_deny;
  // kind: action | row; mode: report_only | enforce. Row decisions are
  // per-request aggregates, so this counts requests, not facts.
  readonly policyDecisions = new Counter({
    name: 'brain_policy_decisions_total',
    help: 'ABAC policy decisions by decision, kind, and mode',
    labelNames: ['decision', 'kind', 'mode'] as const,
    registers: [this.registry],
  });

  // Whole-request row-evaluation cost inside the search/read pipelines.
  // Budget is sub-millisecond at typical K; buckets bottom out at 50 µs
  // so a regression is visible long before it hurts.
  readonly policyEvalDuration = new Histogram({
    name: 'brain_policy_eval_seconds',
    help: 'Per-request ABAC row-evaluation latency in seconds',
    buckets: [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.01, 0.05],
    registers: [this.registry],
  });

  readonly policySetsActive = new Gauge({
    name: 'brain_policy_sets_active',
    help: 'Enabled (enforce or report_only) policy sets, summed across tenants',
    registers: [this.registry],
  });

  // Fail-closed events: a key referenced a policy set that doesn't
  // exist. Non-zero is an operator page — some key is bricked.
  readonly policyResolutionErrors = new Counter({
    name: 'brain_policy_resolution_errors_total',
    help: 'Keys that referenced an unknown policy set (failed closed)',
    registers: [this.registry],
  });

  // A key resolved to MORE than MAX_SETS_PER_KEY distinct sets, so the
  // overflow was dropped. Fail-OPEN: a dropped deny set weakens the
  // key's posture. Non-zero means a binding needs pruning.
  readonly policySetsTruncated = new Counter({
    name: 'brain_policy_sets_truncated_total',
    help: 'Keys whose resolved set list overflowed MAX_SETS_PER_KEY (sets dropped)',
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
      | 'error'
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
    kind: 'identity_link' | 'resolution' | 'corroboration' | 'summary',
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
      // V9 §4: the memory-coverage abstention floor fired.
      | 'low_coverage'
      | 'verifier_partial'
      | 'verifier_failed'
      | 'generator_error'
      // The generator hit the token cap and the partial answer was
      // salvaged (audit W5 #24) — distinct from generator_error, which
      // means we returned nothing at all.
      | 'generator_truncated'
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

  countPromoted(n: number): void {
    if (n > 0) this.promotionFacts.inc(n);
  }

  countFeedback(verdict: 'helpful' | 'not_helpful' | 'incorrect'): void {
    this.feedbackCount.inc({ verdict } as LabelValues<'verdict'>);
  }

  countDocument(result: 'created' | 'deduplicated' | 'failed'): void {
    this.documentsCount.inc({ result } as LabelValues<'result'>);
  }

  countIndexerRun(
    outcome:
      | 'succeeded'
      | 'failed'
      | 'skipped_duplicate'
      | 'reopened'
      | 'stale_reaped'
      | 'claim_released',
  ): void {
    this.indexerRunsCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countCandidate(kind: string, decision: string, n = 1): void {
    if (n > 0) {
      this.candidatesCount.inc(
        { kind, decision } as LabelValues<'kind' | 'decision'>,
        n,
      );
    }
  }

  countCommitMemory(outcome: 'ok' | 'noop' | 'failed'): void {
    this.commitMemoryCount.inc({ outcome } as LabelValues<'outcome'>);
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

  recordJob(
    jobType: string,
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'lost_claim',
    durationSeconds: number,
  ): void {
    this.jobsTotal.inc({ jobType, outcome } as LabelValues<'jobType' | 'outcome'>);
    this.jobDuration.observe(
      { jobType } as LabelValues<'jobType'>,
      durationSeconds,
    );
  }

  setWorkerLeader(isLeader: boolean): void {
    this.workerIsLeader.set(isLeader ? 1 : 0);
  }

  setWorkerJobsInFlight(jobType: string, inFlight: number): void {
    this.workerJobsInFlight.set(
      { jobType } as LabelValues<'jobType'>,
      inFlight,
    );
  }

  countChangefeedConsumed(source: string, n = 1): void {
    if (n > 0) {
      this.changefeedConsumed.inc({ source } as LabelValues<'source'>, n);
    }
  }

  setChangefeedLag(n: number): void {
    this.changefeedLag.set(n);
  }

  setMemoryQuality(snapshot: MemoryQualitySnapshot): void {
    for (const status of FACT_STATUSES) {
      this.memoryFacts.set(
        { status } as LabelValues<'status'>,
        snapshot.factsByStatus[status] ?? 0,
      );
    }
    for (const days of STALE_BUCKETS_DAYS) {
      this.memoryStaleActiveFacts.set(
        { older_than_days: String(days) } as LabelValues<'older_than_days'>,
        snapshot.staleActiveFacts[days] ?? 0,
      );
    }
    for (const band of ['low', 'neutral', 'high'] as const) {
      this.memoryFactTrust.set(
        { band } as LabelValues<'band'>,
        snapshot.trustBands[band],
      );
    }
    this.memoryOrphanEntities.set(snapshot.orphanEntities);
    this.policySetsActive.set(snapshot.policySetsActive);
  }

  countPolicyDecision(
    decision: 'allow' | 'deny' | 'would_deny',
    kind: 'action' | 'row',
    mode: 'report_only' | 'enforce',
  ): void {
    this.policyDecisions.inc({ decision, kind, mode } as LabelValues<
      'decision' | 'kind' | 'mode'
    >);
  }

  observePolicyEval(seconds: number): void {
    this.policyEvalDuration.observe(seconds);
  }

  countPolicyResolutionError(): void {
    this.policyResolutionErrors.inc();
  }

  countPolicySetsTruncated(): void {
    this.policySetsTruncated.inc();
  }

  async serialize(): Promise<{ contentType: string; body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}
