# Architecture

How Brain's read path, background plane, and serving surfaces fit
together — the developer's mental model of the service.

Brain has four moving parts: a layered **retrieval pipeline**, an
optional **multi-hop planner** that chains it, a **synthesize**
guardrail on top, and a **dreams + jobs** background plane — served
over REST and a per-tenant [MCP endpoint](#mcp-surface), with CPU-heavy
work pushed to [worker threads](#worker-threads--process-roles).

## Retrieval pipeline

`POST /v1/search` runs a layered pipeline. Each stage is optional /
env-flagged and tracked in metrics so an operator can A/B per-tenant
impact without redeploying. Production defaults in
[DEPLOY.md](DEPLOY.md); per-flag tuning in [Operations](operations.md).

```
                 query
                   │
                   ▼
     ┌─────────────────────────────┐
     │ predicate + type router     │  joint LLM call → soft
     │ (LRU-cached per query hash) │  distribution over predicates +
     └─────────────────────────────┘  entity types
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
vector leg   lexical leg   (HyPE alt-emb leg)
(HNSW cos)   (BM25)        max(cos_main, cos_alt)
     │             │             │
     └─────────────┼─────────────┘
                   ▼
     convex-fusion (CombMNZ-flavoured, w=0.5)
                   │
                   ▼
     decay × confidence × predicate-boost-α
       (per class; PII discriminators α=1.5)
                   │
                   ▼
     group-by-entity ──→ PPR prior (HippoRAG-style, opt-in)
                   │
                   ▼
     cross-encoder (Cohere Rerank v3.5, opt-in,
                    identity-fallback on error)
                   │
                   ▼
     listwise LLM reranker
       (RankGPT-style + 1-hop SubgraphRAG neighbour context
        + type-prior hint, N=3 self-consistency by Borda count)
                   │
                   ▼
     entity-fact backfill (native Surreal inline subquery
                           via $parent.id; per-entity LIMIT 50;
                           predicate-diverse top-N merge)
                   │
                   ▼
     identity-merge re-attribution
                   │
                   ▼
                 results
```

### Notable design points

- **Backfill is a single SurrealDB SELECT with inline subquery** — not
  a second round-trip. Solves the "leg returned the right entity but
  the matching dob/address fact wasn't in top-K candidates" mode that
  buried predicate-match-rate at 0.4 before.
- **Per-class boost α** — most predicates get 0.5 (soft); PII
  discriminators (`dob`, `email`, `phone`) get 1.5 because a router
  call "this is a dob lookup" should reliably win against a same-
  entity name fact.
- **Bitemporal cutoff is in WHERE** — `validFrom <= asOf < validUntil`
  and `retractedAt IS NONE OR retractedAt > asOf` push down into the
  leg query, no JS post-filter.
- **PII gating** — DB-level via `PERMISSIONS WHERE $caller_scopes
  CONTAINS 'brain:read_pii'` on the `object` field of `address` /
  `dob`. Scoped pool signs in as a non-root editor; scope-less callers
  get NONE for the value but still see the predicate exists.

Full feature-flag matrix → [Operations § Retrieval feature flags](operations.md#retrieval-feature-flags).

## Multi-hop search

`POST /v1/search/multi-hop` runs a CHAINED search: a planner LLM
decomposes the free-text query into ≤ `maxHops` sub-queries with
combination semantics, then the executor runs them in sequence — each
later hop optionally anchored to the running entity set so the search
engine never wastes work on candidates already disqualified upstream.

Combination modes (planner-emitted, per hop):

- **seed** — first hop, no prior set
- **subset_of_previous** — search is anchored via `entityIds` to the
  running set; result is a strict subset. Most chained reasoning
  ("FROM the previous result, KEEP those that ALSO …") uses this.
- **intersect** — hop runs unconstrained; intersect with running set
  after the fact (preserves recall when the prior set is small).
- **union** — hop runs unconstrained; union with running set (rare;
  included for completeness).

When the planner reports `isMultiHop=false`, the executor falls back to
a single-shot search — same shape as `POST /v1/search` but with the
planner's potentially refined `subQuery` / predicate / asOf.

Set `synthesize: true` to feed the final entity set into
`/v1/synthesize` and get a grounded answer alongside the per-hop
trace.

```bash
curl -X POST http://localhost:3000/v1/search/multi-hop \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "tenants who complained in April and upgraded to platinum after",
    "maxHops": 3,
    "synthesize": true
  }'
```

The response carries `hops[]` (per-hop sub-query + entity-id list +
supportingFactIds) plus an aggregated top-level `supportingFactIds`
(de-duped, in execution order). The supporting-facts shape is what
HotpotQA-style **Joint F1** scoring compares against the gold evidence
chain — see `test/eval/metrics/joint-f1.ts`. Use it to catch the
failure mode end-to-end recall@k cannot see: a system that produces the
right answer via the wrong reasoning chain.

## Synthesize (corrective-RAG)

`POST /v1/synthesize` is `/v1/search` with one extra step: the
retrieved facts get fed to a generator LLM that produces a grounded,
citation-bearing answer (each claim ends with `[factId]`), and then a
verifier LLM judges whether every claim is supported by the source
facts. Three modes:

- **strict** (default) — verifier must return `supported`. Anything
  else (`partial` / `unsupported`) collapses to `answer: null` with a
  `reason` field. Fail-closed on verifier outage too.
- **lenient** — verifier still runs, but the answer is returned
  regardless. The verifier's verdict is exposed via `reason` so the
  caller can decide.
- **off** — skip verifier (cheapest; for callers that do their own
  grounding).

Hallucinated `factId` citations (the LLM cited an id not in the
retrieved set) are filtered before the response leaves the server. The
`results` field carries the raw `SearchHit[]` so callers can fall back
to manual synthesis when the answer is null.

For continuous quality measurement, score synthesize outputs against
the retrieved context with `computeFaithfulness` (RAGAS convention —
see `test/eval/metrics/faithfulness.ts`). It decomposes the answer into
atomic claims and returns a 0..1 score plus the per-claim verdicts, so
a regression report points at *which* sentence hallucinated, not just
"this answer was wrong".

## Dreams (off-hours self-improvement)

A daily cron (04:00 UTC, 43 min after compaction) that walks every
tenant and runs three optional sub-passes over the post-compaction
state. Each is independently env-gated; `DREAMS_ENABLED=1` is the
master switch.

| Sub-op | Env flag | What it does |
|---|---|---|
| `summarize` | `DREAMS_LLM_SUMMARY_ENABLED=1` | Replaces the no-LLM concat summarizer in compaction with an LLM-backed version. Produces 1-2 sentence summaries that capture the trajectory ("upgraded from gold to platinum in April") instead of a verbatim concat. Falls back to concat on any LLM error — compaction never breaks. |
| `dedup` | `DREAMS_DEDUP_ENABLED=1` | Two-stage dedup: (1) cosine-similarity over name embeddings finds suspect pairs (threshold `DREAMS_DEDUP_COSINE_THRESHOLD`, default 0.92); (2) LLM judge with both entities' top facts as context decides `same` / `different` / `unsure`. `same` → emits `identity_of` edge automatically. Bounded by `DREAMS_DEDUP_MAX_PAIRS` per tenant per run. |
| `resolve` | `DREAMS_RESOLVE_ENABLED=1` | Auto-resolves `competing` fact pairs aged past `DREAMS_RESOLVE_MIN_AGE_DAYS` (default 7). LLM judge picks a winner using surrounding entity context; loser marked `superseded` with `retractionReason='dreams_resolution'`. Conservative — `unsure` verdict leaves both for human review. |

Manual trigger (scope `brain:admin`):

```bash
curl -X POST http://localhost:3000/v1/dreams/run \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "operations": ["dedup", "resolve"] }'
```

Metrics: `brain_dreams_total{outcome=ok|failed}`,
`brain_dreams_emitted_total{kind=identity_link|resolution|summary}`.
The emitted ratio against ok-runs tells the operator whether dreams is
doing useful work or just spinning.

## Job queue (Phase J/K) — SurrealDB-native, multi-pod safe

Cron-driven work (dreams, compaction, calibration refit, source-trust
refit, reindex) used to execute inline on every brain process — fine
for single-pod deploys, broken under horizontal scale-out where two
pods would double-run the same daily pass. The Phase J/K stack
replaces that with an enqueue/claim model living entirely in
SurrealDB:

```
 cron tick (any pod)
       │ enqueue (UNIQUE jobType, dedupKey)
       ▼
 job_run row {status:'pending', visibleAfter}
       │
       ▼
 WorkerLoopService (leader pod only —
                    gated by 'worker_loop' leader_lease)
       │ claimNext (CAS: status='pending' → 'running',
       │            claimedBy=hostname#pid)
       │ renew every ttl/3 (also: reads cancelRequested
       │                    → propagates AbortSignal)
       │
       ▼
 handler dispatch — in-thread OR JobWorkerPool worker_thread
                    (if cpuBound)
       │
       ▼
 complete / fail (requeue with exponential backoff) / cancelled
       │
       ▼
 LeaseManagerService cron (every 10s)
   reapZombies: status='running' AND leaseUntil < now
                → requeue or terminal-fail
```

### Design notes

- **Why Surreal-native** instead of Redis / pg-boss / k8s Lease — all
  three need a new dependency. Brain already pays for SurrealDB;
  `leader_lease` + `job_run` ride the existing SSI + OCC under
  `retryOnUniqueViolation`. At current scale (~10 jobs/min, 5 cron
  families) it's enough — the migration path to a real queue is open
  if we ever cross 50 jobs/sec.
- **Leader-elected** — one pod runs the polling loop at a time, gated
  by the `worker_loop` lease (ttl=90s, renewed every 30s). On lease
  loss the loop pauses; on re-acquire it resumes. CAS on `claimNext`
  is the ultimate safety net — even during a heartbeat window where
  two pods both think they're leader, only one wins the row.
- **Fairness** — per-poll tenant ordering is weighted by recent-claim
  counter: `weight = 1/(1+recentClaims[jobType::tenant])`. A tenant
  that's just landed N claims gets weight `1/(N+1)` for the next
  cycle; quiet neighbours get tried first. Counter decays by 50%
  every 30s. Phase K2.
- **CPU-bound dispatch** — handlers can opt in via `register(jobType,
  handler, { cpuBound: true, workerModule: '…' })` to be routed
  through `JobWorkerPool` — a fixed-size `node:worker_threads` pool.
  Default `JOB_WORKER_POOL_SIZE=0` (disabled — no current handler is
  cpuBound; BGE-M3 already owns its own worker, every other handler
  is IO-bound). Scaffolding ships for future heavy work. Phase K1.
- **Tracing** — Enqueue → OTel PRODUCER span (`jobs.enqueue`,
  `messaging.system=surrealdb`, traceparent injected into the row).
  Dispatch → CONSUMER span (`jobs.process <jobType>`) linked as a
  child via the row's traceparent. With `OTEL_ENABLED=1` an OTLP
  backend shows the full publish→queue→process waterfall. Phase K3.

### Kill switch — `JOBS_QUEUE_MODE`

Default `enqueue`. Set to `inline` and restart the container —
every cron-decorated handler falls back to the pre-Phase-J path
(`DistributedLeaseGuard.run('dreams_all', () => runAll())` — works
on single pod, no job_run rows written). Use when an unexpected
backlog accumulates in `pending` and the worker loop won't drain
(handler not registered, lease acquire fails, any unforeseen prod
issue). No redeploy needed.

### Admin cockpit

`GET /v1/admin/leases` returns the full picture: which pod holds each
`leader_lease` (with `expired` + `expiresInSeconds`), which job_run
rows are currently in `running` state (with `claimedBy` / `attempts`
/ `lastHeartbeatSecondsAgo`), plus this pod's identity and
`worker_loop` leader flag. The admin UI page at `/admin/leases` auto-
refreshes every 5s and colour-codes stale heartbeats / expired
leases. See [Operator playbook § Drain a stuck queue](operator-playbook.md).

## Worker threads + process roles

Everything CPU-shaped runs off the main event loop in
`node:worker_threads`, so a burst of embeddings or a rerank never
starves HTTP: the BGE-M3 embedder (`BGE_M3_WORKER=1`), the local
ONNX cross-encoder, the NLI intent classifier behind chat routing,
local NER, community label propagation, and tiktoken token counting.
Models lazy-load where they're used, so a pod only pays for what its
role touches.

When one process stops being enough, `PROCESS_ROLE=api|worker|all`
splits the same image into an HTTP-only pod and a jobs pod against the
same SurrealDB — no new infrastructure, just a flag bundle over the
existing worker-loop kill switch and leader leases. Semantics, compose
recipe, and when to actually split:
[Operations § Splitting API and worker roles](operations.md#splitting-api-and-worker-roles).
(A dedicated workflow engine was evaluated and deliberately not
adopted — see [platform-gap-2026-07.md](roadmap/platform-gap-2026-07.md).)

## MCP surface

Every tenant gets a Streamable HTTP MCP endpoint (`ALL /mcp/:companyId`)
serving the same knowledge over agent-native tools: 28 static tools
across read / write / community / procedural / source families
(`ingest_document` registers only under `DOCUMENT_INGEST_ENABLED`),
gated by the caller key's scopes (and, when enabled, per-key
[ABAC policies](abac.md) — enforce-denied tools vanish from
`tools/list`). Two MCP resources (`brain://entity/...`) and sampling
round out the surface; REST and MCP share one action namespace, so a
policy written once gates both.

Installed Domain Packs can extend the surface with consented,
flag-gated tools of their own — declarative query tools over the
pack's predicates or HMAC-proxied external tools. Model + security
posture: [mcp-pack-tools.md](mcp-pack-tools.md).

## See also

- [Data model](data-model.md) — the facts the pipeline retrieves.
- [Bitemporal semantics](bitemporal-semantics.md) — the two clocks behind `asOf`.
- [Document pipeline](document-pipeline.md) — the ingestion plane.
- [Operations](operations.md) — every flag named above, with rollout guidance.
