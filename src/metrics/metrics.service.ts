import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type LabelValues,
} from 'prom-client';
import { isConclusive, type CapabilityName, type ProbeOutcome } from './capability-probe';

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
 *   - scene_maintenance_total{outcome}        — ok|failed|skipped_no_dirty|skipped_budget
 *   - scene_maintenance_emitted_total{kind}   — conversation|scene|enriched|belief|dirty_cleared
 *   - scene_maintenance_duration_seconds      — histogram, per-tenant pass
 *   - capability_probe_total{capability,outcome}  — active probes that RUN
 *   - capability_probe_ok{capability}               a capability on a timer
 *   - capability_probe_last_success_timestamp_seconds{capability}
 *                                               (see capability-probe.ts)
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

  // Write-anomaly counter (G9, docs/roadmap/sota-gap-build-2026-08.md).
  // One series per ingest surface — a memory-injection attack (MINJA-
  // style query-to-belief poisoning, PoisonedRAG doc floods, MCP direct-
  // write abuse) shows up here as a burst/rate anomaly on one path
  // BEFORE any of it reaches retrieval. The alert rules (burst-rate,
  // per-tenant z-score) live ops-side (Alloy/Grafana), out of repo
  // scope — this counter is only the signal they consume.
  //   path: mention | fact | document | candidate | mcp
  // Labels are bounded (5 surfaces); no companyId label (unbounded
  // cardinality — per-tenant bursts are cut from log lines, same rule
  // as every other domain counter here).
  readonly ingestWrites = new Counter({
    name: 'brain_ingest_writes_total',
    help: 'Ingest write attempts by surface (write-anomaly / burst detection)',
    labelNames: ['path'] as const,
    registers: [this.registry],
  });

  // Embedder fallback counter. Non-zero means the configured primary
  // (e.g. bge-m3/1024) was not ready and the OpenAI fallback (1536)
  // answered instead — a cross-space serve. Expected to tick briefly at
  // boot while the ONNX model loads and then stop; a series that keeps
  // climbing means warmup failed and every read is being answered in the
  // wrong space. `primary` labels the configured space, so the series is
  // bounded by deployment config, not by traffic.
  readonly embedderFallbackServes = new Counter({
    name: 'brain_embedder_fallback_serves_total',
    help: 'Embed calls served by the fallback provider because the primary was not ready',
    labelNames: ['primary'] as const,
    registers: [this.registry],
  });

  // Hybrid searches answered lexical-only because the vector leg could not
  // run. `reason` is one of two fixed values: embedder_unavailable (query
  // could not be embedded — primary warming up or down) or
  // vector_query_failed (the similarity statement errored, e.g. rows not
  // in the query's space). A non-zero rate is a degraded read path that
  // /health cannot see.
  readonly searchVectorLegDegraded = new Counter({
    name: 'brain_search_vector_leg_degraded_total',
    help: 'Hybrid searches served lexical-only because the vector leg was unavailable',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  // ── Capability probes (src/metrics/capability-probe.service.ts) ──────
  // The ACTIVE signal for "the service reports healthy while a whole
  // capability is dead" — the class behind #502 (scoped pool anonymous
  // after ~59 min, /health green), #503 (/ready green through embedder
  // warmup) and #510. `/ready` gained real checks in both fixes, but
  // readiness is polled at DEPLOY time; a pool that lapses an hour later
  // is invisible to it. These series come from a timer that actually RUNS
  // each capability.
  //
  // Cardinality: (capability × outcome) only — 2 × 6 worst case. NO
  // companyId label, the same rule as every other domain metric here. The
  // failure is per-PROCESS (one scoped session serves every tenant on the
  // pod), so one canary tenant proves the property for all of them, and
  // the scraper's own `instance` label already pins which pod. The tenant
  // is named in the log line and the runbook, where the operator needs it.
  readonly capabilityProbes = new Counter({
    name: 'brain_capability_probe_total',
    help: 'Capability probe ticks by capability and outcome (serving|unauthorized|degraded|busy|error|skipped)',
    labelNames: ['capability', 'outcome'] as const,
    registers: [this.registry],
  });

  // 1/0 up-signal, written ONLY on a conclusive outcome. A `busy` tick
  // (pool saturated) deliberately leaves the previous value standing: a
  // saturated pool must not page anyone — the same call #502 made in
  // readiness. The series does not exist until the first conclusive probe,
  // so a booting pod (or a disabled probe) is absent, not down.
  readonly capabilityProbeOk = new Gauge({
    name: 'brain_capability_probe_ok',
    help: 'Whether the last CONCLUSIVE probe found this capability serving (1/0); busy/skipped ticks leave it unchanged',
    labelNames: ['capability'] as const,
    registers: [this.registry],
  });

  // When the capability was last observed actually serving. Catches what
  // the up-gauge cannot: a prober that is itself wedged (the gauge would
  // sit at 1 forever) and a pool that has been nothing but busy for a long
  // stretch. Alert on `time() - min by (capability)(…)`.
  readonly capabilityProbeLastSuccess = new Gauge({
    name: 'brain_capability_probe_last_success_timestamp_seconds',
    help: 'Unix time of the last probe that found this capability serving',
    labelNames: ['capability'] as const,
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

  // Scheduled scene maintenance (SCENES_SCHEDULED_MAINTENANCE, migration
  // 0130). Until this pass existed the whole episodic/semantic plane was
  // unobservable: scenes only appeared when an operator curled the admin
  // route, so there was nothing periodic to alert on. Per-TENANT outcomes:
  //   ok               — the tenant pass composed its dirty page
  //   skipped_no_dirty — no conversation had moved since the last pass
  //                      (the steady state on a quiet tenant, and the
  //                      series that proves the dirty trigger works: if
  //                      this never fires, the marks are not being cleared)
  //   skipped_budget   — the run's wall-clock budget expired before this
  //                      tenant started; its marks wait for tomorrow
  //   failed           — the tenant threw; the roster continued
  // No companyId label (unbounded cardinality — the same rule as every
  // other domain counter here); per-tenant detail is cut from log lines.
  readonly sceneMaintenanceCount = new Counter({
    name: 'brain_scene_maintenance_total',
    help: 'Scheduled scene-maintenance tenant passes by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // What the pass actually produced, by kind:
  //   conversation — dirty conversations composed
  //   scene        — scenes written by the swap
  //   enriched     — scenes the LLM enrichment pass re-wrote (the paid leg;
  //                  watch this against `scene` to see the idempotent skip
  //                  working — a steady enriched≈scene ratio on unchanged
  //                  input means the enrichmentVersion composite moved)
  //   belief       — semantic_belief upserts (created + revised +
  //                  corroborated) the promotion leg landed
  //   dirty_cleared— marks retired after a successful swap. dirty_cleared
  //                  lagging `conversation` means turns kept landing during
  //                  the pass (the race fence), not that marks are leaking.
  readonly sceneMaintenanceEmitted = new Counter({
    name: 'brain_scene_maintenance_emitted_total',
    help: 'Scheduled scene-maintenance artefacts by kind',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  // Per-TENANT pass latency. Buckets run to 30 min because the pass is
  // budgeted in that unit (SCENES_MAINTENANCE_TIME_BUDGET_MS defaults to
  // 30 min for the whole roster) — a single tenant approaching the top
  // bucket is the signal that its per-run conversation cap is too high.
  readonly sceneMaintenanceDuration = new Histogram({
    name: 'brain_scene_maintenance_duration_seconds',
    help: 'Scheduled scene-maintenance per-tenant pass latency in seconds',
    buckets: [0.5, 2, 10, 30, 120, 300, 900, 1800],
    registers: [this.registry],
  });

  // Orphan-blob GC tenant passes by outcome:
  //   ok             — a DELETING pass finished (stage two)
  //   dry_run        — a report-only pass finished (stage one, or the
  //                    caller asked for a dry run). This is the series to
  //                    watch before enabling deletion
  //   failed         — the tenant threw; the roster continued
  //   skipped_budget — the run's wall-clock budget expired before this
  //                    tenant started
  readonly evidenceOrphanGcCount = new Counter({
    name: 'brain_evidence_orphan_gc_total',
    help: 'Evidence orphan-blob GC tenant passes by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly hnswProvisionCount = new Counter({
    name: 'brain_hnsw_provision_total',
    help: 'HNSW index provisioning tenant passes by outcome (ready|created|building|partial|absent|mismatch|unknown|dry_run|failed|skipped_budget)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // The roster fold, as of the last reconciliation pass. This is the series
  // that answers "which tenants have a ready index" for an alert — the one
  // question nothing in this service could answer before, because nothing
  // recorded it. `absent` and `mismatch` above zero mean tenants are being
  // served unranked rows with SEARCH_HNSW_ENABLED=1 (#506).
  //
  // Cardinality: one series per state (6), no companyId label — the named
  // list lives in tenant_registry and on the admin roster route, where an
  // operator chasing a specific tenant looks.
  readonly hnswIndexTenants = new Gauge({
    name: 'brain_hnsw_index_tenants',
    help: 'Tenants by recorded HNSW index state as of the last reconciliation pass',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  // What the sweep saw, by kind:
  //   scanned — blobs the store offered
  //   orphan  — unreferenced past the grace window (what a real run
  //             WOULD delete; in stage one this is the whole report)
  //   deleted — actually unlinked (always 0 while the delete flag is off,
  //             so orphan-without-deleted is the "look before you leap"
  //             signal, and deleted ≪ orphan in a real run means a cap or
  //             the budget is biting)
  //   failed  — delete errors, logged and continued
  // No companyId label (unbounded cardinality — the same rule as every
  // other domain counter here); per-tenant detail is cut from log lines.
  readonly evidenceOrphanBlobs = new Counter({
    name: 'brain_evidence_orphan_blobs_total',
    help: 'Evidence orphan-blob GC blobs by kind',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  // Per-TENANT sweep latency. Buckets run to 10 min because that is the
  // default whole-run budget (EVIDENCE_ORPHAN_BLOB_GC_TIME_BUDGET_MS) — a
  // single tenant near the top bucket means the roster cannot finish.
  readonly evidenceOrphanGcDuration = new Histogram({
    name: 'brain_evidence_orphan_gc_duration_seconds',
    help: 'Evidence orphan-blob GC per-tenant pass latency in seconds',
    buckets: [0.1, 0.5, 2, 10, 30, 120, 300, 600],
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

  // Answer-cache decisions (G1, sota-gap-build-2026-08):
  //   hit            — exact-key match, check-on-read passed, served
  //   miss           — no entry / expired / invalidated / cache error
  //   rejected_stale — check-on-read failed; entry invalidated with a
  //                    cause. The HEADLINE metric: its rate by cause is
  //                    exactly how much staleness the fact link caught.
  //   stored         — verified grounded answer admitted (write-through)
  //   bypass         — cache on but request ineligible (explain/empty)
  //   not_admitted   — a supported answer refused at admission (0136):
  //                    its evidence carries an arm the cache cannot
  //                    revalidate, or a dependency was already dead
  readonly answerCacheCount = new Counter({
    name: 'brain_answer_cache_total',
    help: 'Answer-cache decisions by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // L3 escalation outcomes (G2, sota-gap-build-2026-08):
  //   fired                 — the ladder escalated (anchor present, ran)
  //   flipped               — escalation changed the verdict fail→pass;
  //                           the L3 answer was returned. THE canary:
  //                           near-zero flip rate means the gate is
  //                           miscalibrated (escalating where raw
  //                           context cannot help either).
  //   no_flip               — escalated but the verifier still failed;
  //                           fell through to the normal abstention path
  //   skipped_no_anchor     — trigger conditions met but no retrieved
  //                           fact named a session — abstain, no
  //                           full-context call burned
  //   over_budget_degraded  — selected sessions exceeded L3_TOKEN_CAP;
  //                           degraded to widened L2 windows (still one
  //                           generation; flipped/no_flip also counted)
  // The monotone single-shot ladder means at most one 'fired' per query.
  readonly l3EscalationCount = new Counter({
    name: 'brain_l3_escalation_total',
    help: 'L3 confidence-gated escalation outcomes',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Optics-2 (docs/roadmap/fovea-optics-2026-08.md §4.1): which sub-
  // condition fired the L3 trigger —
  //   adaptive — the calibrated-focus-confidence floor (FOVEA_ADAPTIVE_L3
  //              on with a usable per-class calibration model)
  //   static   — the coverage<floor floor (flag off, or no usable model:
  //              the byte-identical fallback path)
  // Counted once per fired trigger, in lockstep with the 'fired' branch of
  // brain_l3_escalation_total. A separate metric (not a new label on the
  // outcome counter) keeps the existing outcome series stable.
  readonly l3TriggerPathCount = new Counter({
    name: 'brain_l3_adaptive_trigger_total',
    help: 'L3 escalation trigger path: adaptive (calibrated confidence) vs static (coverage floor)',
    labelNames: ['path'] as const,
    registers: [this.registry],
  });

  // L3 anchor independence: which anchor source(s) fed a fired
  // escalation's final ranked session set —
  //   fact     — grounding stamps of already-retrieved facts (the
  //              original resolveAnchors path)
  //   direct   — BM25 episode hits on the query text
  //              (RETRIEVAL_L3_DIRECT_ANCHOR)
  //   segment  — dense+BM25 RRF-fused episode_segment hits
  //              (RETRIEVAL_L3_SEGMENT_ANCHOR)
  //   temporal — conversations active in the query-named period
  //              (RETRIEVAL_L3_TEMPORAL_ANCHOR)
  // Counted once per fired escalation per source that contributed ≥1
  // anchor to the ranked set (several sources can count on one fire).
  // A separate counter — NOT new labels on brain_l3_escalation_total —
  // keeps the existing outcome series stable (the Optics-2 precedent
  // above).
  readonly l3AnchorSourceCount = new Counter({
    name: 'brain_l3_anchor_source_total',
    help: 'L3 escalation anchor sources contributing to the fired session set',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  // L3 evidence citations (FOVEA_L3_EPISODE_CITATIONS): per-citation
  // resolution outcome of the citedEpisodes the L3 generator emitted —
  //   span_anchored   — the quote verified verbatim against the stored
  //                     turn text (anchorQuote) → the citation carries a
  //                     code-point span
  //   episode_only    — quote absent/ambiguous/unverifiable → the
  //                     citation degrades to episodeId-only
  //   dropped_unknown — the generator named an episodeId NOT rendered
  //                     into the transcript (hallucination / probe) →
  //                     dropped, never surfaced
  // Emitted only when the flag is on (nothing on the path when off). A
  // separate counter — NOT new labels on brain_l3_escalation_total —
  // keeps the existing outcome series stable (the Optics-2 precedent).
  readonly l3EpisodeCitationCount = new Counter({
    name: 'brain_l3_episode_citation_total',
    help: 'L3 evidence (episode) citation resolution outcomes (FOVEA_L3_EPISODE_CITATIONS)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Fragment citations (EVIDENCE_FRAGMENT_CITATIONS, MM-zoom PR2) — the
  // l3-episode-citation sibling for the fragment lane's rendered-set
  // resolver:
  //   cited           — the generator named a RENDERED fragment → a
  //                     fragment-arm citation shipped
  //   dropped_unknown — the generator named a fragmentId NOT rendered
  //                     into the media section (hallucination / probe)
  //                     → dropped, never surfaced
  // Emitted only when the flag is on (nothing on the path when off).
  readonly fragmentCitationCount = new Counter({
    name: 'brain_fragment_citation_total',
    help: 'Fragment evidence citation resolution outcomes (EVIDENCE_FRAGMENT_CITATIONS)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // BELIEFS_SERVING_LANE: what happened to each generator-emitted
  // citedBeliefIds entry in the rendered-set resolver
  // (belief-citations.ts — the fragmentCitationCount sibling):
  //   cited           — the generator named a RENDERED belief → a
  //                     belief-arm citation shipped
  //   dropped_unknown — the generator named a beliefId NOT rendered
  //                     into the current-state section (hallucination /
  //                     probe) → dropped, never surfaced
  // Emitted only when the flag is on (nothing on the path when off).
  readonly beliefCitationCount = new Counter({
    name: 'brain_belief_citation_total',
    help: 'Belief evidence citation resolution outcomes (BELIEFS_SERVING_LANE)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // RETRIEVAL_SCENE_LANE: what happened to each generator-emitted
  // citedSceneIds entry in the rendered-set resolver
  // (scene-citations.ts — the beliefCitationCount sibling):
  //   cited           — the generator named a RENDERED scene → a
  //                     scene-arm citation shipped
  //   dropped_unknown — the generator named a sceneId NOT rendered into
  //                     the episodic section (hallucination / probe) →
  //                     dropped, never surfaced
  // Emitted only when the lane is on (nothing on the path when off).
  readonly sceneCitationCount = new Counter({
    name: 'brain_scene_citation_total',
    help: 'Scene evidence citation resolution outcomes (RETRIEVAL_SCENE_LANE)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // BELIEFS_FACT_DAMPING: what the prompt-side damping pass did per
  // evaluation (belief-damping.ts — the beliefCitationCount sibling):
  //   damped — one increment PER fact line suffixed + demoted because a
  //            lane-matched CURRENT belief covers its (subject, field)
  //            with a different value (per-entry counting, the
  //            countBeliefCitation idiom)
  //   clean  — the pass evaluated (flag on AND matched beliefs present)
  //            but no fact line contradicted a matched belief
  // Emitted only when the pass actually evaluates — flag off, lane off,
  // or no matched beliefs put nothing on the path. A V13-refined
  // request evaluates the pass once per generation round.
  readonly beliefDampingCount = new Counter({
    name: 'brain_belief_damping_total',
    help: 'Belief-aware fact-damping outcomes (BELIEFS_FACT_DAMPING)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // MM-zoom PR3 (FOVEA_FRAGMENT_ZOOM): what the ONE bounded zoom step did
  // per evaluation —
  //   flipped   — the re-verify over the fuller derived text passed →
  //               the answer served
  //   unchanged — the re-verify still failed → the normal downgrade ran
  //   skipped   — the step evaluated (flag on, verdict failed) but had
  //               nothing to zoom (no truncated rendered fragment / no
  //               deeper text fetched)
  //   error     — any failure inside the step (degraded to static)
  // Emitted only when the flag is on (nothing on the path when off).
  readonly fragmentZoomCount = new Counter({
    name: 'brain_fragment_zoom_total',
    help: 'Fragment zoom step outcomes (FOVEA_FRAGMENT_ZOOM)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Optics §4.2 (docs/roadmap/fovea-optics-2026-08.md §4.2): which sub-
  // condition fired the pre-generation memory-coverage ABSTAIN decision —
  //   adaptive — the calibrated-pre-answer-confidence floor
  //              (FOVEA_ADAPTIVE_ABSTAIN on with a usable per-class
  //              pre-answer calibration model)
  //   static   — the coverage<floor floor (flag off, or no usable model:
  //              the byte-identical fallback path)
  // Counted once per abstain decision, alongside the existing
  // countSynthesize('low_coverage') outcome tag. A separate metric (not a
  // new outcome value) keeps the synthesize outcome series stable.
  readonly abstainPathCount = new Counter({
    name: 'brain_abstain_path_total',
    help: 'Coverage-abstain decision path: adaptive (calibrated confidence) vs static (coverage floor)',
    labelNames: ['path'] as const,
    registers: [this.registry],
  });

  // Verifier answer-integrity arm, Part A (FOVEA_PLAUSIBILITY_CHECK): a
  // `supported` verdict was DOWNGRADED to an abstain because the
  // post-grounding plausibility judge flagged the cited premise as
  // implausible / out-of-context (belief distortion,
  // docs/roadmap/memtrap-shakedown-2026-08.md class 4). Counted once per
  // downgrade, alongside the existing countSynthesize('low_coverage') outcome
  // tag. A separate series (not a new outcome value) keeps the synthesize
  // outcome series stable. Incremented only when the flag is on.
  readonly plausibilityDowngradeCount = new Counter({
    name: 'brain_plausibility_downgrade_total',
    help: 'Supported answers downgraded to abstain by the post-grounding plausibility judge (FOVEA_PLAUSIBILITY_CHECK)',
    registers: [this.registry],
  });

  // Verifier answer-integrity arm, Part C (FOVEA_REQUIRE_CITATIONS): a
  // `supported` verdict carrying ZERO citations was abstained rather than
  // served as an uncited answer (audit F2(b)). Counted once per abstain,
  // alongside the existing countSynthesize('low_coverage') outcome tag. A
  // separate series keeps the synthesize outcome series stable. Incremented
  // only when the flag is on.
  readonly citationGuardAbstainCount = new Counter({
    name: 'brain_citation_guard_abstain_total',
    help: 'Zero-citation supported answers abstained by the require-citations guard (FOVEA_REQUIRE_CITATIONS)',
    registers: [this.registry],
  });

  // Evidence-capability verdict gate (FOVEA_EVIDENCE_CAPABILITY, 0113):
  //   checked    — the gate resolved the required capability over a
  //                supported answer's cited facts (fires once per resolved
  //                check, pass or downgrade — the denominator)
  //   downgraded — a supported answer was abstained because its required
  //                NON-TEXT capability had no cited evidence (reason
  //                'evidence_capability_unmet' on the wire)
  // Counted only when the flag is on. The synthesize outcome series stays
  // stable (the downgrade still tags 'low_coverage' there, the Part A/C
  // idiom) — this separate series carries the capability-specific signal.
  readonly evidenceCapabilityCount = new Counter({
    name: 'brain_evidence_capability_total',
    help: 'Evidence-capability verdict gate outcomes (FOVEA_EVIDENCE_CAPABILITY)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  // Ungrounded-support serving gate (EVIDENCE_UNGROUNDED_SERVING_GATE,
  // 0115): a supported answer whose EVERY cited fact carries
  // groundingStatus='ungrounded' was abstained (reason
  // 'ungrounded_evidence' on the wire). Counted once per downgrade,
  // alongside the stable countSynthesize('low_coverage') outcome tag —
  // the Part A/C separate-series idiom. Incremented only when the flag
  // is on.
  readonly ungroundedDowngradeCount = new Counter({
    name: 'brain_ungrounded_downgrade_total',
    help: 'Supported answers abstained because every cited fact was ungrounded (EVIDENCE_UNGROUNDED_SERVING_GATE)',
    registers: [this.registry],
  });

  // Optics §4.3 (docs/roadmap/fovea-optics-2026-08.md §4.3): the
  // lens-suppression governor's per-request outcome —
  //   suppressed     — a confident class match removed ≥1 active lane
  //   no_model       — flag on, no usable per-class suppression model
  //   low_confidence — the nearest centroid's cosine is below the floor
  //   floor_kept     — a match would empty the active set → original kept
  //   no_op          — a confident match whose suppress set is disjoint
  // Emitted only when the flag is on (nothing on the hot path when off).
  // A separate series, distinct from the synthesize outcome counter.
  readonly lensSuppressionCount = new Counter({
    name: 'brain_lens_suppression_total',
    help: 'Lens-suppression governor outcomes (Optics §4.3)',
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

  // Language-attribution distribution (multilingual Tier 1,
  // MULTILINGUAL_LANG_ATTRIBUTION). One series per (detected language ×
  // surface × detector version) — the Prometheus mirror of the Tier-0
  // aggregator's byLanguage / bySource / byDetectorVersion rollups
  // (test/eval/metrics/language-attribution.ts). Labels are bounded:
  // ~13 languages (incl. 'und') × 4 surfaces × a small detector-version
  // set; no companyId (unbounded cardinality, same rule as every other
  // domain counter). Emitted ONLY while attribution is on — off = no
  // series, byte-identical.
  //   lang: en|ru|es|…|und   source: query|fact|answer|mention
  readonly langAttribution = new Counter({
    name: 'brain_lang_attribution_total',
    help: 'Language-attribution decisions by detected language, surface, and detector version',
    labelNames: ['lang', 'source', 'detectorVersion'] as const,
    registers: [this.registry],
  });

  // Confidence distribution of the same decisions, per surface — supplies
  // the aggregator's meanConfidence (via _sum/_count) and lowConfidenceRate
  // (the cumulative bucket at the 0.7 threshold). Bounded to the 4 surfaces.
  readonly langAttributionConfidence = new Histogram({
    name: 'brain_lang_attribution_confidence',
    help: 'Detector confidence of language-attribution decisions, by surface',
    labelNames: ['source'] as const,
    buckets: [0.1, 0.3, 0.5, 0.7, 0.9, 1],
    registers: [this.registry],
  });

  readonly retracts = new Counter({
    name: 'brain_retract_total',
    help: 'Number of fact retractions',
    registers: [this.registry],
  });

  // Evidence plane (PROVENANCE_RECURSIVE_CLOSURE): one recursive
  // support-closure walk over derivedFrom per provenance read —
  //   resolved  — walk completed inside every cap, ≥1 supporting fact
  //   truncated — a depth / fan-out / episode cap cut the walk short
  //               (partial closure still served)
  //   empty     — walk ran but no visible supporting fact remained
  //               (dangling derivedFrom, or every member fenced)
  readonly provenanceClosureCount = new Counter({
    name: 'brain_provenance_closure_total',
    help: 'Recursive provenance closure walks by outcome',
    labelNames: ['outcome'] as const,
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

  /**
   * Record one ingest write attempt on a surface (G9 write-anomaly
   * signal). `mcp` is an ORIGIN overlay — an MCP record_fact fires both
   * `mcp` (here) and `fact` (in FactIngestService), so sum-across-labels
   * is not meaningful; query per-path for burst detection.
   */
  countIngestWrite(path: 'mention' | 'fact' | 'document' | 'candidate' | 'mcp'): void {
    this.ingestWrites.inc({ path } as LabelValues<'path'>);
  }

  observeSearchDuration(seconds: number): void {
    this.searchDuration.observe(seconds);
  }

  countRerank(
    outcome: 'invoked' | 'error' | 'skipped_disabled' | 'skipped_singleton' | 'skipped_margin',
  ): void {
    this.searchRerankCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countCrossEncoder(
    outcome:
      | 'invoked'
      | 'error'
      | 'skipped_disabled'
      | 'skipped_singleton'
      | 'fact_invoked'
      | 'fact_error',
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
    outcome: 'ok' | 'single_hop' | 'chain_empty' | 'no_results' | 'planner_error' | 'hop_error',
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
      // V13 constrained search loop: the one refine round ran (the
      // final outcome is still counted separately by the exits above).
      | 'search_loop_refined'
      // Multilingual Tier 5 (answer-language guard): an output-language
      // mismatch triggered the ONE corrective regeneration.
      | 'answer_lang_retry'
      // Tier 5: the answer was STILL not in the target language after that
      // retry (the bounded "then flag" — served best-effort).
      | 'answer_lang_unresolved'
      | 'verifier_error',
  ): void {
    this.synthesizeCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countAnswerCache(
    outcome: 'hit' | 'miss' | 'rejected_stale' | 'stored' | 'bypass' | 'not_admitted',
  ): void {
    this.answerCacheCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countL3Escalation(
    outcome: 'fired' | 'flipped' | 'no_flip' | 'skipped_no_anchor' | 'over_budget_degraded',
  ): void {
    this.l3EscalationCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countL3TriggerPath(path: 'adaptive' | 'static'): void {
    this.l3TriggerPathCount.inc({ path } as LabelValues<'path'>);
  }

  countL3AnchorSource(source: 'fact' | 'direct' | 'segment' | 'temporal'): void {
    this.l3AnchorSourceCount.inc({ source } as LabelValues<'source'>);
  }

  countL3EpisodeCitation(
    outcome: 'span_anchored' | 'episode_only' | 'dropped_unknown',
    n = 1,
  ): void {
    if (n > 0) {
      this.l3EpisodeCitationCount.inc({ outcome } as LabelValues<'outcome'>, n);
    }
  }

  countFragmentCitation(outcome: 'cited' | 'dropped_unknown', n = 1): void {
    if (n > 0) {
      this.fragmentCitationCount.inc({ outcome } as LabelValues<'outcome'>, n);
    }
  }

  countBeliefCitation(outcome: 'cited' | 'dropped_unknown', n = 1): void {
    if (n > 0) {
      this.beliefCitationCount.inc({ outcome } as LabelValues<'outcome'>, n);
    }
  }

  countSceneCitation(outcome: 'cited' | 'dropped_unknown', n = 1): void {
    if (n > 0) {
      this.sceneCitationCount.inc({ outcome } as LabelValues<'outcome'>, n);
    }
  }

  countBeliefDamping(outcome: 'damped' | 'clean', n = 1): void {
    if (n > 0) {
      this.beliefDampingCount.inc({ outcome } as LabelValues<'outcome'>, n);
    }
  }

  countFragmentZoom(outcome: 'flipped' | 'unchanged' | 'skipped' | 'error'): void {
    this.fragmentZoomCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countAbstainPath(path: 'adaptive' | 'static'): void {
    this.abstainPathCount.inc({ path } as LabelValues<'path'>);
  }

  countPlausibilityDowngrade(): void {
    this.plausibilityDowngradeCount.inc();
  }

  countCitationGuardAbstain(): void {
    this.citationGuardAbstainCount.inc();
  }

  countEvidenceCapability(outcome: 'checked' | 'downgraded'): void {
    this.evidenceCapabilityCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countUngroundedDowngrade(): void {
    this.ungroundedDowngradeCount.inc();
  }

  countLensSuppression(
    outcome: 'suppressed' | 'no_model' | 'low_confidence' | 'floor_kept' | 'no_op',
  ): void {
    this.lensSuppressionCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  /**
   * Record one language-attribution decision (multilingual Tier 1). The
   * argument is exactly the Tier-0 `LanguageAttributionSample` shape
   * (src/eval/types.ts), so the emitted series roll up to the same
   * distribution report the eval aggregator produces. Behaviour-neutral —
   * callers invoke it only while MULTILINGUAL_LANG_ATTRIBUTION is on, so
   * with the flag off nothing is emitted and serving is byte-identical.
   */
  recordLangAttribution(sample: {
    lang: string;
    source: 'query' | 'fact' | 'answer' | 'mention';
    confidence: number;
    detectorVersion: string;
  }): void {
    this.langAttribution.inc({
      lang: sample.lang,
      source: sample.source,
      detectorVersion: sample.detectorVersion,
    } as LabelValues<'lang' | 'source' | 'detectorVersion'>);
    this.langAttributionConfidence.observe(
      { source: sample.source } as LabelValues<'source'>,
      sample.confidence,
    );
  }

  countRetract(): void {
    this.retracts.inc();
  }

  countProvenanceClosure(outcome: 'resolved' | 'truncated' | 'empty'): void {
    this.provenanceClosureCount.inc({ outcome } as LabelValues<'outcome'>);
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
      'succeeded' | 'failed' | 'skipped_duplicate' | 'reopened' | 'stale_reaped' | 'claim_released',
  ): void {
    this.indexerRunsCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countCandidate(kind: string, decision: string, n = 1): void {
    if (n > 0) {
      this.candidatesCount.inc({ kind, decision } as LabelValues<'kind' | 'decision'>, n);
    }
  }

  countCommitMemory(outcome: 'ok' | 'noop' | 'failed'): void {
    this.commitMemoryCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countSceneMaintenance(outcome: 'ok' | 'failed' | 'skipped_no_dirty' | 'skipped_budget'): void {
    this.sceneMaintenanceCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countSceneMaintenanceEmitted(
    kind: 'conversation' | 'scene' | 'enriched' | 'belief' | 'dirty_cleared',
    n = 1,
  ): void {
    if (n > 0) {
      this.sceneMaintenanceEmitted.inc({ kind } as LabelValues<'kind'>, n);
    }
  }

  countEvidenceOrphanGc(outcome: 'ok' | 'dry_run' | 'failed' | 'skipped_budget'): void {
    this.evidenceOrphanGcCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  countHnswProvision(outcome: string): void {
    this.hnswProvisionCount.inc({ outcome } as LabelValues<'outcome'>);
  }

  setHnswIndexTenants(state: string, n: number): void {
    this.hnswIndexTenants.set({ state } as LabelValues<'state'>, n);
  }

  countEvidenceOrphanBlobs(kind: 'scanned' | 'orphan' | 'deleted' | 'failed', n = 1): void {
    if (n > 0) {
      this.evidenceOrphanBlobs.inc({ kind } as LabelValues<'kind'>, n);
    }
  }

  observeEvidenceOrphanGcDuration(seconds: number): void {
    this.evidenceOrphanGcDuration.observe(seconds);
  }

  observeSceneMaintenanceDuration(seconds: number): void {
    this.sceneMaintenanceDuration.observe(seconds);
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
    this.jobDuration.observe({ jobType } as LabelValues<'jobType'>, durationSeconds);
  }

  /**
   * Publish one capability-probe tick.
   *
   * The counter takes every outcome; the up-gauge takes only CONCLUSIVE
   * ones, so a busy pool cannot flip a capability "down" — see
   * `isConclusive` in capability-probe.ts for why that distinction lives
   * in the metric rather than in the alert threshold.
   */
  recordCapabilityProbe(
    capability: CapabilityName,
    outcome: ProbeOutcome,
    atMs: number = Date.now(),
  ): void {
    this.capabilityProbes.inc({ capability, outcome } as LabelValues<'capability' | 'outcome'>);
    if (!isConclusive(outcome)) return;
    this.capabilityProbeOk.set(
      { capability } as LabelValues<'capability'>,
      outcome === 'serving' ? 1 : 0,
    );
    if (outcome === 'serving') {
      this.capabilityProbeLastSuccess.set(
        { capability } as LabelValues<'capability'>,
        Math.floor(atMs / 1000),
      );
    }
  }

  setWorkerLeader(isLeader: boolean): void {
    this.workerIsLeader.set(isLeader ? 1 : 0);
  }

  setWorkerJobsInFlight(jobType: string, inFlight: number): void {
    this.workerJobsInFlight.set({ jobType } as LabelValues<'jobType'>, inFlight);
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
      this.memoryFactTrust.set({ band } as LabelValues<'band'>, snapshot.trustBands[band]);
    }
    this.memoryOrphanEntities.set(snapshot.orphanEntities);
    this.policySetsActive.set(snapshot.policySetsActive);
  }

  countPolicyDecision(
    decision: 'allow' | 'deny' | 'would_deny',
    kind: 'action' | 'row',
    mode: 'report_only' | 'enforce',
  ): void {
    this.policyDecisions.inc({ decision, kind, mode } as LabelValues<'decision' | 'kind' | 'mode'>);
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
