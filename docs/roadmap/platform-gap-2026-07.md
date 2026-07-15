# Platform gap analysis — July 2026

Outcome of the concept-compliance audit (2026-07-15): where the
"open cognitive infrastructure" story stands after the W-wave (workers)
and PL-wave (platform) landed, which architectural decisions were made,
and which directions deliberately wait for product input.

## Where the platform stands

Community extensibility now covers the full loop:

- **Domain Packs** — versioned, signed, checksum-addressed JSON
  manifests; per-tenant install/upgrade/uninstall without redeploy;
  authoring on-ramp (`pnpm pack:init` → validate → sign → publish →
  install; CONTRIBUTING has the recipe).
- **Global registry** — publish/discover/install with immutable
  versions, yank, download counters, verified-publisher badges, and
  pull-only cross-instance mirroring (`REGISTRY_UPSTREAM_URL`).
- **External indexers** — a complete third-party execution seam:
  work-discovery pull API (poll → claim → content → submit), signed
  webhook push hints, per-pack key binding, span re-grounding, run
  ledger, earned source-trust. Spec: [indexer-protocol.md](../indexer-protocol.md);
  reference client: `examples/reference-indexer.ts`.
- **OpenAPI** — the platform surface is machine-described in
  `docs/openapi.json` (drift-guarded by a regenerate-and-diff spec).

## Decision: Temporal — not adopted

Evaluated 2026-07-15 against the homegrown SurrealDB-native job system
(~2k LOC: dedupKey idempotency, CAS claims, lease renew/reaper,
exponential backoff, cross-pod cancel, weighted tenant fairness, OTel
spans). Verdict: **keep the homegrown system.**

- Temporal server + its own Postgres store don't fit the current
  single-droplet footprint, and would double the persistence surface.
- Multi-tenancy here is SurrealDB-native (per-company job tables behind
  scoped connections); Temporal would re-encode it as task-queue
  conventions and the fairness layer would be rebuilt anyway.
- The one workflow-shaped construct (index_document fan-out → deferred
  commit_document) is hand-rolled, tested, and stable in production.

**Re-evaluate when any of these fires:**

1. Horizontal scale-out to >1 worker node is genuinely needed and the
   `PROCESS_ROLE` compose split (below) is no longer enough.
2. Workflow shapes deeper than the current 2-stage DAG appear —
   multi-day human-in-the-loop flows, cross-service sagas, per-workflow
   versioned migrations.
3. Sustained job throughput approaches ~5 jobs/sec (per-tenant CAS
   polling becomes measurable DB load).
4. A compliance requirement for replayable execution history.

Migration seam if that day comes: `WorkerLoopService.register()` call
sites become activity registrations; `JobClaimService.enqueue()` call
sites become workflow starts.

## Worker-role split — built, enable when needed

`PROCESS_ROLE=api|worker|all` ships with a compose recipe
(`profiles: ["split"]`); see operations.md § "Splitting API and worker
roles". Enable when: the host grows past ~4 CPU / 4GB, or API p95
event-loop lag exceeds ~100ms during the nightly job window, or HA
requires ≥2 pods. Until then the in-process worker offloads (NLI,
local NER, cross-encoder, label propagation, token counting) keep the
event loop clear at zero extra memory baseline.

## Directions that wait for product decisions

These are NOT engineering backlog — each needs a product call (pricing,
curation, security posture) before code makes sense. Draft proposals to
react to:

- **Marketplace economic layer.** The registry already has the
  prerequisite telemetry (downloads, verified badges). The missing
  decisions: paid packs or free-only? Who curates — first-party review,
  reputation, or open? Proposal: start with a "featured" curated list +
  publisher profiles on the registry UI; defer payments until a pack has
  organic demand.
- **In-process code plugins.** Deliberately rejected: arbitrary
  third-party code in the tenant process breaks the security model. The
  external-indexer seam IS the sanctioned extension point (out-of-process,
  scoped, re-grounded). Revisit only with a sandboxing story (isolates/WASM)
  and a concrete use-case polling can't serve.
- **Pluggable trust-score specs.** Source-trust already adapts per
  external indexer (neutral 0.5 + nightly refit). A plug point for
  custom trust math has no consumer yet. Proposal: expose trust
  *inputs* (per-source agreement stats) read-only via the API first;
  build the plug point when someone actually consumes them.
- **Knowledge-content package format.** Packs carry ontology, not
  facts. Shipping pre-populated knowledge (fixtures, reference data)
  has a different lifecycle (updates, provenance, dedup vs tenant
  facts). Proposal: model it as a seed *document set* ingested through
  the normal pipeline (provenance intact) rather than a new format.
- **MCP tool plugins.** Third-party tool injection into the MCP surface
  is a separate security review (tool descriptions reach LLM agents —
  prompt-injection surface). Proposal: packs may *declare* extra MCP
  read tools bound to their predicates, server-rendered from a
  template, never free-form code or prompts.

## Residual engineering backlog (small)

- Extractor span-grounding offload: no event-loop-lag evidence yet;
  profile during heavy ingest before moving it to the pool (the
  functions are already pure — same recipe as label propagation).
- `JOB_WORKER_POOL_SIZE` right-sizing once several pool consumers
  coexist (token counting + label propagation today).
- LoCoMo benchmark run (paid, ~$110) — unchanged from the previous
  roadmap; publish numbers when run.
