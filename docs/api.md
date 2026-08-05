# API reference

An index of every HTTP endpoint Brain serves, grouped by area, with
auth scopes — for anyone calling Brain over REST or wiring an admin UI.
A generated [OpenAPI 3.1 document](openapi.json) covers the platform
surface (registry, packs, documents, indexer work) with full request /
response schemas — regenerate with `pnpm openapi:build`; this page
stays an index, not a second spec.

All v1 endpoints are live; MCP transport is mounted per tenant. Every
v1 call requires `Authorization: Bearer <credential>` — an
auth-service JWT (verified via JWKS; `org`+`sub` = tenant+user,
bare `sub` = M2M tenant), a long-lived `ik_…` API key (resolved via
RFC 7662 introspection), or a static `BRAIN_API_KEYS` entry (dev
fallback). Admin endpoints require `brain:admin` scope on top of base
auth; PII surfaces require `brain:read_pii`. Tokens may additionally
carry RFC 9396 `inite_mcp_resource` grants (per-tool MCP permissions,
enforced on tools/list) and a `policy` claim (ABAC set names — see
operator-playbook, "Per-agent rights"). Unauthenticated requests
get `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728) pointing
at the discovery document below.

## Health + observability

| Endpoint | Notes |
|---|---|
| `GET /health` | Container + SurrealDB readiness. No auth. |
| `GET /ready` | Readiness probe (schema + connectivity). No auth. |
| `GET /metrics` | Prometheus exposition (in-cluster scrape; keep off the public surface). |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata: which authorization server protects this deployment + user-delegable scopes. No auth — MCP clients use it to self-onboard. |

## Ingest

| Endpoint | Notes |
|---|---|
| `POST /v1/ingest/fact` | Declared structured fact ingest. Optional `userId` stamps a per-user memory scope (0055): scope-local conflict resolution, invisible outside that user. |
| `POST /v1/ingest/mention` | NLU extraction → entities + facts. With `INGEST_MENTION_VIA_DOCUMENT=1`, routed through the document pipeline (same response shape). |
| `POST /v1/ingest/link` | Typed edge between entities (incl. `identity_of` for cross-vertical merge). |

## Documents (Source → Indexer → Candidates → Brain)

All routes answer `503 feature_disabled` until `DOCUMENT_INGEST_ENABLED=1`.
See [Document pipeline](document-pipeline.md) for the architecture.

| Endpoint | Notes |
|---|---|
| `POST /v1/ingest/document` | Normalized-document ingest: store (content-hash deduped, PII-redacted, chunked) → indexer runs → staged candidates → CommitMemory. `storeContent:false` keeps only hash+metadata. `mode:'async'` fans indexer runs onto the job queue (requires `DOCUMENT_MULTI_INDEXER_ENABLED`). |
| `GET /v1/documents/:id` | Document header + indexer-run ledger; `?includeText=1` returns stored chunks. |
| `GET /v1/documents/:id/candidates` | The Candidates-layer audit view — every staged hypothesis with status / reason / commitRef. |
| `POST /v1/documents/:id/candidates` | EXTERNAL indexer submission (scope `indexer:write`): batch is validated against the pack registration, namespace-fenced, and span-re-grounded against stored text before staging. Optional `runId`+`claimToken` fulfil a claimed work item. |
| `POST /v1/documents/:id/commit` | Manual (re)commit of pending candidates (admin). |
| `DELETE /v1/documents/:id/content` | Purge stored chunks; header + contentHash survive (admin). |
| `POST /v1/admin/documents/reindex` | Backfill: run one pack's extraction over all stored documents (admin). External packs get work items instead of in-process runs. |

### External-indexer work discovery (scope `indexer:write`)

Protocol: [indexer-protocol.md](indexer-protocol.md).

| Endpoint | Notes |
|---|---|
| `GET /v1/indexer/work?packId=&limit=` | Pending work items (pull): documents ingest routed to the tenant's installed external packs. |
| `POST /v1/indexer/work/:runId/claim` | CAS claim → `claimToken` + lease; optional for single-instance pollers. |
| `POST /v1/indexer/work/:runId/heartbeat` | Renew the claim lease (`{claimToken}`). |
| `GET /v1/indexer/work/:runId/content` | Stored chunks of the claimed/pending document (verbatim source text). |
| `POST /v1/indexer/work/:runId/fail` | Release back to the pool (default) or `permanent:true` to mark failed. |

## Read

| Endpoint | Notes |
|---|---|
| `POST /v1/search` | Hybrid (vector + BM25), router-boosted, listwise rerank w/ self-consistency, per-leg CI, entity-fact backfill. `userId` scopes results to tenant-global + that user's personal memory (fail-closed: omitted → global only); also on `/synthesize` and `/search/multi-hop`. See [Architecture § Retrieval pipeline](architecture.md#retrieval-pipeline). |
| `POST /v1/synthesize` | Corrective-RAG with strict / lenient / off guardrails + claim-level faithfulness scorer. See [Architecture § Synthesize](architecture.md#synthesize-corrective-rag). |
| `POST /v1/search/multi-hop` | Planner-LLM decomposes the query into ≤N anchored sub-queries; carries supportingFactIds for HotpotQA-style joint-F1 eval. See [Architecture § Multi-hop](architecture.md#multi-hop-search). |
| `GET /v1/entities/autocomplete?q=` | Entity-name typeahead over the edge-ngram `prefix` fulltext index (word-start match, BM25-ranked via `search::score`). `?limit=` 1–25 (default 10); a query under 2 chars returns empty. Live, tenant-global entities only (merged-away redirects and personal-scoped entities excluded). |
| `GET /v1/entities/:id` | Entity profile + active facts (PII-gated by scope). `?asOf=` slices world-time; `?recordedAt=` slices transaction-time (what the graph believed at T — a later retract/supersede is ignored). |
| `GET /v1/entities/:id/timeline` | Bitemporal sweep — `fact.recorded` / `fact.retracted` events on the transaction-time axis. `?since=`/`?until=` page the window; `?recordedAt=` cuts to events known by T. |
| `GET /v1/entities/:id/connections` | Typed edges + direct neighbours. |
| `GET /v1/artifacts/:type/:entityId` | Derived artifacts (profile / digest / etc) with manual `recompile` POST. |
| `GET /v1/sources` | Read-only trust inputs: declared `type`/`authLevel` ⋈ learned reputation, one row per source. Filters `domain` / `type` / `minSamples`, paginated (`limit` ≤ 200 / `offset`). Public projection — operator annotations (`owner`/`note`) stay on the admin surface. |
| `GET /v1/sources/:sourceKey` | One source's declared identity, per-domain trust rows, and reputation history (newest first, ≤ 50). Same data as the `get_source_reputation` MCP tool. |
| `GET /v1/communities` | Persisted graph communities (label propagation), paginated. |
| `GET /v1/communities/search` | Vector search over community summaries. |
| `GET /v1/communities/for-entity/:entityId` | Communities an entity belongs to. |
| `GET /v1/stats/overview` | Tenant-level counts (entities / facts / edges) for dashboards. |

## Raw-substrate driver (episodes + projections)

The L0 substrate as a public contract
([design](roadmap/raw-substrate-driver-2026-08.md)): any consumer can
build its own projection without speaking SurrealQL to our database.
All routes 404 until their flag is on.

| Endpoint | Notes |
|---|---|
| `GET /v1/episodes` | Verbatim pre-extraction turns, keyset-paged over `(occurredAt, id)` (`?cursor=` resumes); filters `conversationId`/`speaker`/`since`/`until`, `limit` ≤ 200. Without `brain:read_pii` only piiClass-clean rows are visible. Flag `EPISODES_API_ENABLED`. |
| `GET /v1/episodes/export` | Same filtered stream as NDJSON, one episode per line, paged internally. Flag `EPISODES_API_ENABLED`. |
| `POST /v1/episodes/subscriptions` | Register an http(s) endpoint for signed `episodes_available` pushes (`brain:admin`). The HMAC secret is returned **exactly once**. Pushes are metadata-only (ids/attribution/timestamps — never text), at-least-once, watermarked over `recordedAt`; signature `X-Brain-Signature: sha256=<hex hmac>` over the raw body. Flag `EPISODE_SUBSCRIPTIONS_ENABLED`. |
| `GET /v1/episodes/subscriptions` | Registered endpoints (secrets never included). |
| `DELETE /v1/episodes/subscriptions/:id` | Remove an endpoint (`brain:admin`). |
| `GET /v1/projections` | Derived surfaces as first-class records (migration 0076): status `building/built/live/residual/failed`, watermark, builder, stats, plus the live read pin (`RETRIEVAL_DERIVED_VERSION`). Flag `PROJECTIONS_API_ENABLED`. |
| `POST /v1/projections/:name/rebuild` | The public rebuild verb over the maintenance batch engine (`brain:admin`; v1 rebuilds `facts` via the session-window deriver). Body: `version` / `conversation` / `activate` / `force`. Flag `PROJECTIONS_API_ENABLED`. |

## Mutation (audited)

| Endpoint | Notes |
|---|---|
| `POST /v1/facts/:id/retract` | Mark a fact retracted with reason; survives in audit trail. |
| `POST /v1/feedback` | Retrieval feedback: `helpful` / `not_helpful` / `incorrect` per fact. One standing vote per caller key (repeat replaces); `helpful`/`incorrect` feed the nightly source-trust refit. **Affects the SOURCE's trust for facts ingested AFTER the refit — it does not demote the flagged fact or the existing corpus** (ranking reads each fact's write-time trust snapshot). Also on MCP as `record_feedback`. |
| `POST /v1/entities/:id/forget` | Hard GDPR cascade — facts + edges + embeddings deleted, HMAC tombstone retained. |
| `POST /v1/users/:userId/forget` | GDPR erasure of one end-user's memory scope (migration 0055): personal facts (incl. those on shared entities), personal entities + edges + dedup refs, usage/feedback rows, audit mirror. |

## Background work

| Endpoint | Notes |
|---|---|
| `POST /v1/dreams/run` | Off-hours self-improvement: dedup / resolve / summarize (admin scope). |

## Domain Packs (admin)

Manifest format + install semantics: [domain-packs.md](domain-packs.md).
All routes `brain:admin`.

| Endpoint | Notes |
|---|---|
| `GET /v1/admin/packs` | Installed packs for the tenant. |
| `POST /v1/admin/packs` | Install/upgrade from a manifest body (`{manifest, expectedChecksum?, acceptMcpTools?}`). A manifest with an `mcpTools` section **requires `acceptMcpTools: true`** (400 otherwise; re-required when an upgrade changes the section). Response includes `webhookSecret` (once, external packs) and `seedDocuments: {count, status}` when the manifest ships seeds. |
| `POST /v1/admin/packs/from-registry` | Install from the global registry (`{packId, version?, acceptMcpTools?}`). Paid packs answer a self-describing `402` until the entitlement exists — see [Marketplace](domain-packs.md#marketplace). |
| `POST /v1/admin/packs/:packId/eval` | Run the pack's own `evalFixtures` through the live extractor (`?mode=union\|dedicated`). |
| `DELETE /v1/admin/packs/:packId` | Uninstall — deprecates the pack's predicates; facts survive. |

## Registry + marketplace

Global pack catalogue (shared `system` database) + instance-local
marketplace state. Semantics: [domain-packs.md § Registry](domain-packs.md#the-registry-global-catalogue).

| Endpoint | Scope | Notes |
|---|---|---|
| `GET /v1/registry/packs` | `brain:read` | Discovery: `?q=&tag=&publisher=`; carries `featured` / download counters / `verified` / `origin` (mirrored rows). |
| `GET /v1/registry/packs/:packId` | `brain:read` | All versions + latest. |
| `GET /v1/registry/packs/:packId/:version` | `brain:read` | One version (`latest` accepted). |
| `GET /v1/registry/publishers/:publisher` | `brain:read` | Publisher page: profile (or null) + published packs. |
| `POST /v1/admin/registry/packs` | `registry:publish` | Publish a manifest; `(packId, version)` immutable, identical republish idempotent. |
| `POST /v1/admin/registry/packs/:packId/:version/yank` / `unyank` | `registry:publish` | Flag a bad version out of resolution; never deletes. |
| `PUT /v1/admin/registry/packs/:packId/pricing` | `registry:publish` | Price the pack (`{amount, currency}`, minor units); mints a billing product + price. |
| `DELETE /v1/admin/registry/packs/:packId/pricing` | `registry:publish` | Back to free. |
| `POST /v1/admin/registry/packs/:packId/checkout` | `brain:admin` | Create a billing checkout session for a paid pack (`{successUrl?, errorUrl?}`, optional `idempotency-key` header). |
| `POST /v1/admin/registry/packs/:packId/feature` / `unfeature` | `registry:curate` | Featured curation (hosting-operator scope). |
| `PUT /v1/admin/registry/publishers/:publisher` | `registry:publish` | Upsert the public publisher profile (requires ≥1 verified pack under that publisher id). |
| `GET /registry/ui` · `GET /registry/ui/publisher/:publisher` | none | Public server-rendered HTML catalogue / publisher page. |

## Admin — sources

Source registry + trust management (all `brain:admin`); the model lives
in [source-reputation.md](source-reputation.md).

| Endpoint | Notes |
|---|---|
| `GET /v1/admin/sources` | Registry ⋈ learned trust, one row per source (includes `owner` / `note`). |
| `GET /v1/admin/sources/:sourceKey` | Detail: per-domain trust rows + history + recent facts. |
| `PUT /v1/admin/sources/:sourceKey` | Declare `type` / `authLevel` / `owner` / `note`. |

## Admin — jobs + leases

| Endpoint | Notes |
|---|---|
| `GET /v1/admin/jobs` | List job_run rows (filter by jobType / status / since / companyId). |
| `GET /v1/admin/jobs/:runId` | Single job_run detail. |
| `POST /v1/admin/jobs/:runId/cancel` | Flip `cancelRequested=true` — worker loop aborts on next renew tick. |
| `GET /v1/admin/jobs/stream` | SSE stream of job_run transitions for live dashboard. |
| `GET /v1/admin/leases` | leader_lease snapshot + active claims across tenants (Phase J cockpit). |
| `GET /v1/admin/scheduler` | Registered cron entries with last/next fire timestamps. |
| `POST /v1/admin/maintenance/dreams/run` | Fire-and-forget kick of dreams; returns `{accepted, jobType, companyId}` (no runId — poll `GET /v1/admin/maintenance/dreams/runs/:runId/emits` for a specific run). |
| `POST /v1/admin/maintenance/calibration-refit` | Async kick of calibration + source-trust refit. |
| `POST /v1/admin/maintenance/reindex` | Async re-embed `knowledge_fact`, optionally per tenant. |
| `POST /v1/admin/maintenance/compaction` | Fire-and-forget kick of the compaction (+promotion) pass. |
| `POST /v1/admin/maintenance/hnsw` | Per-tenant HNSW vector-index lifecycle: `{action: 'create' \| 'drop', tenant?}`. Synchronous. `create` refuses (`400`) when an index already exists at a different dimension — recover in order: drop → reindex embeddings → create. |
| `GET /v1/admin/changefeed/state` | Consumer lag + per-(tenant, source) cursor table. |
| `POST /v1/admin/changefeed/drain` | Manual drain of pending change events. |

Every admin endpoint listed in [`src/contracts/admin/`](../src/contracts/admin/)
has a zod wire contract. The browser-side BFF at
`brain-landing/app/api/admin/proxy/[...path]/route.ts` parses every
response through the same schema — drift becomes a loud 502 instead of
a quiet stale field.

## Admin — governance + ops

The rest of the `brain:admin` surface, compactly (one row per family —
the admin UI at brain-landing is the primary consumer):

| Family | Endpoints | Notes |
|---|---|---|
| Overview + audit | `GET /v1/admin/overview`, `GET /v1/admin/audit` | Tenant dashboard counts; filterable `audit_event` feed. |
| Predicates | `GET/POST /v1/admin/predicates`, `PATCH/DELETE /v1/admin/predicates/:id`, `POST …/:id/promote`, `POST …/:id/alias` | Tenant predicate-registry CRUD + proposed→active promotion + alias lifecycle. |
| Ops | `GET /v1/admin/config`, `GET /v1/admin/dlq`, `DELETE /v1/admin/dlq/:companyId/:id`, `GET /v1/admin/forgotten` (+`/export`), `GET /v1/admin/pii`, `GET /v1/admin/operator-actions` | Config catalogue (effective values + defaults), dead-letter queue, forget tombstones, PII-surface inventory, operator action log. |
| Infra | `GET /v1/admin/health/components`, `GET /v1/admin/migrations`, `GET /v1/admin/throttler`, `GET /v1/admin/now` | Component health, per-tenant migration ledger, rate-limiter state, server clock. |
| Retrieval ops | `GET /v1/admin/router/stats`, `GET /v1/admin/cost`, `GET /v1/admin/calibration`, `POST /v1/admin/reindex/embeddings` | Router cache stats, LLM cost rollups, calibration curves, re-embed kick. |
| Eval | `GET /v1/admin/scenarios` (+`/:id`, `POST /:id/run`, `POST /run-batch`), `GET/POST /v1/admin/baselines…`, `GET /v1/admin/traces…` | Runtime scenario runner over `src/eval/`, baseline diffing, debug traces. |
| Dreams detail | `GET /v1/admin/dreams/runs/:runId/emits`, `GET /v1/admin/dreams/summary`, `POST /v1/admin/dreams/run` | Per-run emit drill-down + rollups; synchronous dreams trigger. |
| Code memory | `GET /v1/admin/code-memory/anchors`, `POST /v1/admin/code-memory/anchors/apply` | Drift-resistant anchor review + apply. |
| Demo | `POST /v1/admin/demo/*`, `GET /v1/admin/demo/state` | Sandboxed demo-tenant flows for the public playground. |
| Tenancy | `DELETE /v1/admin/tenants/:companyId` | Whole-tenant erasure (`REMOVE DATABASE`). |

## MCP

| Endpoint | Notes |
|---|---|
| `ALL /mcp/:companyId` | Streamable HTTP MCP endpoint per tenant. Besides the static tool families, installed Domain Packs with a consented `mcpTools` section contribute tools named `<packId>__<toolName>` (behind `MCP_PACK_TOOLS_ENABLED`, default off) — see [mcp-pack-tools.md](mcp-pack-tools.md). Installing such a pack requires `acceptMcpTools: true` in the `POST /v1/admin/packs` (or `/from-registry`) body; a changed section on upgrade re-requires it. The unauthenticated `/health` probe lists only the static read baseline. |

## Auth + scopes

| Scope | Grants |
|---|---|
| `brain:read` | All read endpoints; PII facts only as `__pii_redacted__` placeholder. |
| `brain:write` | All ingest endpoints. |
| `brain:read_pii` | Lifts the PII gate — `dob` / `email` / `phone` / `address` facts return real values. |
| `brain:admin` | All `/v1/admin/*` endpoints, dreams trigger, retraction / forget. |
| `registry:publish` | Publish/yank in the global pack registry (catalogue shared across tenants); also pricing + publisher-profile writes for the publisher's own packs. |
| `registry:curate` | Feature/unfeature packs in the catalogue — a hosting-operator scope, distinct from `registry:publish` (publishers manage their own packs; curation ranks everyone's). Env-key-only, like `registry:publish`. |
| `indexer:write` | Stage candidates as an external indexer (`POST /v1/documents/:id/candidates`) — can propose hypotheses, never write facts directly. Optionally pack-bound: a key with `packIds` (static entry) or a `packs` JWT claim acts ONLY as those pack identities (403 outside the binding). |

Keys are stored as `sha256:<hex>` — see [Getting started](getting-started.md#seed-an-apikey)
for the seeding flow.

## ABAC policy sets

Scopes are coarse (any `brain:read` key reads the whole tenant graph); [ABAC
policy sets](abac.md) narrow individual keys. Behind `ABAC_ENABLED` (default
off). All endpoints require `brain:admin`; wire contracts live in
`src/contracts/admin/policies.schema.ts`.

| Method + path | Purpose |
|---|---|
| `GET /v1/admin/policy-sets` | List sets with attachments. |
| `POST /v1/admin/policy-sets` | Create from a policy document (zod-validated: ≤64 rules, ≤32 KB). |
| `GET /v1/admin/policy-sets/:name` | Fetch one. |
| `PUT /v1/admin/policy-sets/:name` | Whole-document replace; body carries the loaded `version`, stale → `409 {error: 'version_conflict', current}`. Names are immutable. |
| `DELETE /v1/admin/policy-sets/:name` | Delete; `409 policy_attached` while any key references it. |
| `GET /v1/admin/policy-sets/bindings/all` | Every subject → set-names binding. |
| `POST /v1/admin/policy-sets/:name/attachments` | `{attach: [subject], detach: [subject]}`; subjects are `key:<keyHash>` (static keys) or `jwt:<sub>`. Validates the set exists — this is what keeps the resolver's fail-closed branch unreachable. |
| `POST /v1/admin/policy-sets/explain` | `{policyNames, action?, factId?}` → per-rule decision traces (which condition matched, expected vs actual). |
| `GET /v1/admin/policy/registry` | Everything the policy editor's pickers need: gateable actions (name/family/kind), macro expansions, attribute vocabulary with per-tenant autocomplete hints. |
| `POST /v1/admin/policy/simulate/search` | `{subject: {keyId \| policyNames \| inline draft, modeOverride?}, query}` → runs the REAL search pipeline and returns ALL rows annotated `{decision, reasons[]}` — the Key Lens diff (denied rows included; admin-only). |
| `POST /v1/admin/policy/simulate/actions` | Same subject → per-action verdict for the whole action registry (the action matrix). |
| `POST /v1/admin/policy/preview-rule` | `{rule}` → approximate live match count + 3 sample facts (sampled over the most recent 5 000 active facts). |
| `GET /v1/admin/policy/decisions` | Cursor-paginated decision feed (`policySet/decision/kind/action/before` filters). `GET …/stats?windowDays=` → series, top denied actions/rules/keys, report_only promotion candidates. |
| `GET /v1/admin/keys` | Read-only static-key inventory: `keyId`, binding `subject`, scopes, attached policy sets. |

A key acquires policies three ways, unioned and capped at 8: a
`policy_binding` row (attachments above), a `"policies": [...]` field on its
`BRAIN_API_KEYS` entry, or a `policy` claim (array or space-delimited string)
in its JWT. A referenced name that doesn't resolve **fails closed** — the key
gets a synthetic enforce/deny-all set and
`brain_policy_resolution_errors_total` increments.

Denied REST calls answer `403 {error: 'policy_denied', action, policySet,
ruleId}`. Enforce-denied MCP tools disappear from `tools/list` entirely.

## See also

- [OpenAPI 3.1 spec](openapi.json) — request/response schemas for the platform surface (generated).
- [Operations](operations.md) — the env flags that gate whole endpoint families.
- [Domain Packs](domain-packs.md) — pack manifest + registry + marketplace semantics.
- [External indexer protocol](indexer-protocol.md) — the work API end to end.
