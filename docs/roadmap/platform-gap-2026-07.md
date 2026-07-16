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

## Product decisions — resolved 2026-07-16

All five directions received product decisions and (where code was the
answer) shipped:

- **Marketplace economic layer — DECIDED, shipped.** Featured curation
  (`registry:curate` scope) + publisher profiles on the registry UI, AND
  paid packs wired to the central billing service immediately (it was
  already deployed). Entitlement key `domain_pack:<packId>`, pull-only
  verification, fail-closed, 402 → checkout → retry-install flow. See
  docs/domain-packs.md § "Marketplace" and docs/operations.md for the
  billing prerequisites. Behind `DOMAIN_PACK_BILLING_ENABLED` (default
  off — self-hosted instances treat the catalogue as free).
- **In-process code plugins — still rejected** (decision unchanged):
  arbitrary third-party code in the tenant process breaks the security
  model. The external seams (indexers, external MCP tools) are the
  sanctioned extension points. Revisit only with a sandboxing story
  (isolates/WASM) and a concrete use-case the out-of-process seams
  can't serve.
- **Pluggable trust-score specs — DECIDED, shipped.** Trust *inputs*
  (per-source agreement stats, declared authority, bounded history) are
  exposed read-only under `brain:read` via `GET /v1/sources` and
  `GET /v1/sources/:sourceKey`. The plug point for custom trust math is
  deliberately deferred until someone actually consumes these inputs.
- **Knowledge-content package format — DECIDED, shipped.** Packs ship
  pre-populated knowledge as `seedDocuments` ingested through the
  NORMAL document pipeline on install (provenance, dedup, and trust
  intact; no new fact format). See docs/domain-packs.md § "Seed
  documents".
- **MCP tool plugins — DECIDED, shipped (full plugins).** The
  template-only proposal was superseded by the product decision to go
  further: packs declare MCP tools — declarative *query* tools locked
  to the pack's predicate namespace, and *external* tools proxied to a
  pack-operated HTTPS endpoint with per-install HMAC signing. Sanitized
  author text behind an unspoofable server preamble, explicit
  install-time consent (`acceptMcpTools`), SSRF egress guard, and
  everything behind default-off flags. See docs/mcp-pack-tools.md.

## Residual engineering backlog (small)

- Extractor span-grounding offload: no event-loop-lag evidence yet;
  profile during heavy ingest before moving it to the pool (the
  functions are already pure — same recipe as label propagation).
- `JOB_WORKER_POOL_SIZE` right-sizing once several pool consumers
  coexist (token counting + label propagation today).
- LoCoMo benchmark run (paid, ~$110) — unchanged from the previous
  roadmap; publish numbers when run.
