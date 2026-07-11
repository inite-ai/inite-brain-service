# API reference

All v1 endpoints are live; MCP transport is mounted per tenant. Every
v1 call requires `Authorization: Bearer <plaintext>` where the key's
SHA-256 lives in `BRAIN_API_KEYS`. Admin endpoints require
`brain:admin` scope on top of base auth; PII surfaces require
`brain:read_pii`.

## Health + observability

| Endpoint | Notes |
|---|---|
| `GET /health` | Container + SurrealDB readiness. No auth. |
| `GET /metrics` | Prometheus exposition (in-cluster scrape). |

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
| `POST /v1/documents/:id/candidates` | EXTERNAL indexer submission (scope `indexer:write`): batch is validated against the pack registration, namespace-fenced, and span-re-grounded against stored text before staging. |
| `POST /v1/documents/:id/commit` | Manual (re)commit of pending candidates (admin). |
| `DELETE /v1/documents/:id/content` | Purge stored chunks; header + contentHash survive (admin). |
| `POST /v1/admin/documents/reindex` | Backfill: run one pack's extraction over all stored documents (admin). |

## Read

| Endpoint | Notes |
|---|---|
| `POST /v1/search` | Hybrid (vector + BM25), router-boosted, listwise rerank w/ self-consistency, per-leg CI, entity-fact backfill. `userId` scopes results to tenant-global + that user's personal memory (fail-closed: omitted → global only); also on `/synthesize` and `/search/multi-hop`. See [Architecture § Retrieval pipeline](architecture.md#retrieval-pipeline). |
| `POST /v1/synthesize` | Corrective-RAG with strict / lenient / off guardrails + claim-level faithfulness scorer. See [Architecture § Synthesize](architecture.md#synthesize-corrective-rag). |
| `POST /v1/search/multi-hop` | Planner-LLM decomposes the query into ≤N anchored sub-queries; carries supportingFactIds for HotpotQA-style joint-F1 eval. See [Architecture § Multi-hop](architecture.md#multi-hop-search). |
| `GET /v1/entities/:id` | Entity profile + active facts (PII-gated by scope). |
| `GET /v1/entities/:id/timeline` | Bitemporal sweep — all facts ever known, with validFrom / validUntil / recordedAt / retractedAt. |
| `GET /v1/entities/:id/connections` | Typed edges + direct neighbours. |
| `GET /v1/artifacts/:type/:entityId` | Derived artifacts (profile / digest / etc) with manual `recompile` POST. |

## Mutation (audited)

| Endpoint | Notes |
|---|---|
| `POST /v1/facts/:id/retract` | Mark a fact retracted with reason; survives in audit trail. |
| `POST /v1/feedback` | Retrieval feedback: `helpful` / `not_helpful` / `incorrect` per fact. One standing vote per caller key (repeat replaces); `helpful`/`incorrect` feed the nightly source-trust refit. Also on MCP as `record_feedback`. |
| `POST /v1/entities/:id/forget` | Hard GDPR cascade — facts + edges + embeddings deleted, HMAC tombstone retained. |
| `POST /v1/users/:userId/forget` | GDPR erasure of one end-user's memory scope (migration 0055): personal facts (incl. those on shared entities), personal entities + edges + dedup refs, usage/feedback rows, audit mirror. |

## Background work

| Endpoint | Notes |
|---|---|
| `POST /v1/dreams/run` | Off-hours self-improvement: dedup / resolve / summarize (admin scope). |

## Admin — jobs + leases

| Endpoint | Notes |
|---|---|
| `GET /v1/admin/jobs` | List job_run rows (filter by jobType / status / since / companyId). |
| `GET /v1/admin/jobs/:runId` | Single job_run detail. |
| `POST /v1/admin/jobs/:runId/cancel` | Flip `cancelRequested=true` — worker loop aborts on next renew tick. |
| `GET /v1/admin/jobs/stream` | SSE stream of job_run transitions for live dashboard. |
| `GET /v1/admin/leases` | leader_lease snapshot + active claims across tenants (Phase J cockpit). |
| `GET /v1/admin/scheduler` | Registered cron entries with last/next fire timestamps. |
| `POST /v1/admin/maintenance/dreams/run` | Async kick of dreams (returns runId). |
| `POST /v1/admin/maintenance/calibration-refit` | Async kick of calibration + source-trust refit. |
| `POST /v1/admin/maintenance/reindex` | Async re-embed `knowledge_fact`, optionally per tenant. |
| `POST /v1/admin/maintenance/hnsw` | Per-tenant HNSW vector-index lifecycle: `{action: 'create' \| 'drop', tenant?}`. Synchronous. `create` refuses (`400`) when an index already exists at a different dimension — recover in order: drop → reindex embeddings → create. |
| `GET /v1/admin/changefeed/state` | Consumer lag + per-(tenant, source) cursor table. |
| `POST /v1/admin/changefeed/drain` | Manual drain of pending change events. |

Every admin endpoint listed in [`src/contracts/admin/`](../src/contracts/admin/)
has a zod wire contract. The browser-side BFF at
`brain-landing/app/api/admin/proxy/[...path]/route.ts` parses every
response through the same schema — drift becomes a loud 502 instead of
a quiet stale field.

## MCP

| Endpoint | Notes |
|---|---|
| `ALL /mcp/:companyId` | Streamable HTTP MCP endpoint per tenant. |

## Auth + scopes

| Scope | Grants |
|---|---|
| `brain:read` | All read endpoints; PII facts only as `__pii_redacted__` placeholder. |
| `brain:write` | All ingest endpoints. |
| `brain:read_pii` | Lifts the PII gate — `dob` / `email` / `phone` / `address` facts return real values. |
| `brain:admin` | All `/v1/admin/*` endpoints, dreams trigger, retraction / forget. |
| `registry:publish` | Publish/yank in the global pack registry (catalogue shared across tenants). |
| `indexer:write` | Stage candidates as an external indexer (`POST /v1/documents/:id/candidates`) — can propose hypotheses, never write facts directly. |

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
