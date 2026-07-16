<p align="center">
  <a href="https://brain.inite.ai">
    <img src="https://brain.inite.ai/api/og?title=Memory%20that%20keeps%20time&kind=brand" alt="INITE Brain — memory that keeps time" width="100%">
  </a>
</p>

<h1 align="center">INITE Brain</h1>

<p align="center">
  <b>Open-source bitemporal knowledge graph — long-term memory for AI agents.</b><br>
  Typed facts on a graph, two clocks per fact, hybrid retrieval, conflict-aware ingest,<br>
  and a GDPR forget that actually deletes. Over REST and a native MCP endpoint.
</p>

<p align="center">
  <a href="https://github.com/inite-ai/inite-brain-service/actions/workflows/ci.yml"><img src="https://github.com/inite-ai/inite-brain-service/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/inite-ai/inite-brain-service/stargazers"><img src="https://img.shields.io/github/stars/inite-ai/inite-brain-service?style=flat" alt="Stars"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
  <img src="https://img.shields.io/badge/TypeScript-3178c6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/MCP-native-ffb938.svg" alt="MCP native">
</p>

<p align="center">
  <a href="https://brain.inite.ai">Website</a> ·
  <a href="https://brain.inite.ai/en/docs">Docs</a> ·
  <a href="https://brain.inite.ai/en/blog">Blog</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

Most "memory" for AI agents is a vector store: embed text, return what looks
similar. That can't tell you *when* something was true, can't reconcile two
sources that disagree, and can't truly delete a user on request. **Brain** is
a per-tenant knowledge graph built for those jobs — a *system of insight, not
a system of record*.

```mermaid
flowchart LR
  subgraph ingest ["Ingest"]
    facts["facts · mentions · links"]
    docs["documents<br/>Source → Indexer → Candidates"]
  end
  ext["external indexers ✳<br/>pull work API"] --> docs
  packs["Domain Packs ✳<br/>registry · marketplace"] -. "predicates · indexers<br/>seed documents" .-> ingest
  facts --> resolver["conflict resolver<br/>+ trust snapshot"]
  docs --> resolver
  resolver --> graph[("bitemporal graph<br/>two clocks per fact")]
  graph --> retrieval["retrieval pipeline<br/>vector + BM25 → router → PPR →<br/>cross-encoder → LLM rerank"]
  retrieval --> rest["REST /v1"]
  retrieval --> mcp["MCP per tenant<br/>+ pack tools ✳"]
```

✳ = extension points for third parties — see [Build on Brain](#build-on-brain).

## Why Brain

- **Two clocks per fact.** Every fact carries *valid time* (when it was true)
  and *transaction time* (when Brain learned it). Query `now`, or replay
  exactly what the graph knew on any past date. History is replayed, never
  rewritten.
- **A retrieval pipeline, not a cosine match.** Hybrid vector + BM25 fusion →
  HyPE → predicate router → graph edge-expansion → tier-aware PPR →
  cross-encoder → listwise LLM rerank with self-consistency.
- **Conflict-aware ingest.** Two ingests for one fact go through a scored
  ladder; close calls land as `COMPETING`, not a silent overwrite.
- **Source-aware trust.** A fact isn't *true* — it's *claimed by a source,
  trusted under context*. Every fact records who claimed it plus a reputation
  snapshot taken at write time; reputation is **domain-scoped** (a source strong
  on one predicate isn't trusted blindly on another), agreement across sources
  **corroborates**, and the trust that moves a ranking is stored with its
  "because" decomposition — never recomputed behind your back.
- **Per-key access policies (ABAC).** Scopes say *may this key search*;
  policy sets say *what it may see*: allow/deny rules over MCP tools and REST
  actions, plus row-level read filtering by predicate, PII class, source
  vertical, projected document metadata (`data_class: pii`), numeric trust
  thresholds, and corroboration. Deny-overrides, report-only rollout, per-rule
  explain, and a visual policy editor + Key Lens simulator in the admin UI.
  See [`docs/abac.md`](docs/abac.md).
- **Pluggable ontology — as a platform.** Domain Packs extend the predicate
  registry without forking core: signed, versioned JSON manifests that carry
  predicates, extraction tuning, eval fixtures, indexer descriptors, seed
  documents, and MCP tools. A six-pack industry library ships in-repo
  (real-estate, fintech, medical, legal, insurance, HR); a global registry
  with immutable versions, verified-publisher badges, download counters, and
  pull-only mirroring closes the publish → discover → install loop.
- **An execution seam for third parties.** External indexers contribute
  knowledge over a pull work API — poll → claim → read content → submit
  candidates — without ever running inside Brain's process. Every submitted
  span is re-grounded against the stored document text, and indexer trust is
  earned through the nightly refit, not granted.
- **Pack-declared MCP tools.** A pack can extend a tenant's MCP surface:
  declarative query tools locked to its own predicates, or HMAC-signed proxies
  to a publisher-operated endpoint. Registered only with explicit operator
  consent, flag-gated, never in-process code.
- **A marketplace with honest defaults.** Featured curation, publisher
  profiles, and paid packs via a central billing service (per-pack
  entitlements, self-describing 402 → checkout → retry, fail-closed when
  billing is unreachable). With billing off — the default — every pack
  installs free: the self-hosted posture.
- **A document pipeline, not an upload button.** Ingestion is split into four
  layers — *Source* (a normalized document; Brain doesn't know what a PDF is) →
  *Indexer* (composable domain readers: one meeting can be read by the meetings,
  sales, and tasks indexers at once) → *Candidates* ("this MIGHT be a fact" — a
  staged hypothesis, not yet memory) → *Brain* (merge, dedupe, conflict-resolve,
  then commit). Stored documents can be **re-indexed** when a new pack lands,
  and corroboration is keyed on the *origin document*, so two indexers reading
  the same source never masquerade as independent evidence.
- **A forget that deletes.** GDPR erasure is a synchronous hard cascade —
  facts, edges, and embeddings gone, only an HMAC tombstone left to prove it.
- **Native MCP.** A per-tenant Streamable HTTP endpoint with scope-aware tools.
  Hermes, Claude Desktop, Cursor, Goose, n8n — same URL, no glue code; stdio-only
  harnesses connect via the [`@inite/brain-mcp`](https://www.npmjs.com/package/@inite/brain-mcp) connector.
- **Eval-gated in CI.** Every push re-runs the retrieval + memory-lifecycle
  suite; a regression past tolerance blocks the merge.

## Quick start

Self-host the whole stack with Docker:

```bash
git clone https://github.com/inite-ai/inite-brain-service
cd inite-brain-service

docker compose up -d surrealdb     # storage
pnpm install
cp .env.example .env               # set OPENAI_API_KEY + BRAIN_API_KEYS
pnpm start:dev
```

Ingest a fact, then search for it:

```bash
curl -X POST localhost:3000/v1/ingest/fact \
  -H "Authorization: Bearer $BRAIN_KEY" -H "Content-Type: application/json" \
  -d '{ "entityRef": {"vertical":"rent","id":"cust_42"},
        "predicate": "complained_about", "object": "late maintenance",
        "validFrom": "2026-05-05T10:00:00Z",
        "source": {"vertical":"rent","messageId":"msg_1"} }'

curl -X POST localhost:3000/v1/search \
  -H "Authorization: Bearer $BRAIN_KEY" -H "Content-Type: application/json" \
  -d '{ "query": "maintenance issues", "limit": 5 }'
```

Prefer not to run it? The same API is hosted at **[brain.inite.ai](https://brain.inite.ai)**.
Full walkthrough: [Getting started](https://brain.inite.ai/en/docs/getting-started).

## Connect an agent

Brain is an MCP server, so any MCP-capable agent gets long-term memory by
pointing at the per-tenant URL with a Bearer key — no glue code.

- **Harnesses with native remote MCP** (Hermes, Claude Desktop, Cursor, Goose v2,
  n8n, Continue.dev) connect directly. Add brain to the harness's MCP config with
  `url: https://brain.inite.ai/mcp/<companyId>` and an `Authorization: Bearer <key>`
  header. Example for [Hermes](https://hermes-agent.nousresearch.com)
  (`~/.hermes/config.yaml`):

  ```yaml
  mcp_servers:
    brain:
      url: "https://brain.inite.ai/mcp/<companyId>"
      headers:
        Authorization: "Bearer <api-key>"
  ```

- **stdio-only harnesses** that can't attach an auth header (openclaw, Goose 1.x)
  spawn the first-party [`@inite/brain-mcp`](https://www.npmjs.com/package/@inite/brain-mcp)
  connector, which transparently proxies every scoped tool over Streamable HTTP:

  ```json
  { "mcp": { "servers": { "brain": {
    "command": "npx", "args": ["-y", "@inite/brain-mcp"],
    "env": { "BRAIN_API_KEY": "brain_xxx", "BRAIN_COMPANY_ID": "<companyId>" }
  }}}}
  ```

Full per-client guide: [MCP setup](https://brain.inite.ai/en/docs/mcp/setup).
Installed Domain Packs can extend the tool surface with their own consented,
flag-gated tools — see [MCP pack tools](docs/mcp-pack-tools.md).

## Feed it documents

Beyond single facts and 16K mentions, Brain ingests whole normalized documents
through the **Source → Indexer → Candidates → Brain** pipeline (flagged off by
default — set `DOCUMENT_INGEST_ENABLED=1`):

```bash
curl -X POST localhost:3000/v1/ingest/document \
  -H "Authorization: Bearer $BRAIN_KEY" -H "Content-Type: application/json" \
  -d '{ "kind": "markdown", "title": "Q3 review with Acme",
        "text": "<normalized document text, up to 512K chars>",
        "occurredAt": "2026-07-01T10:00:00Z",
        "contextRef": {"vertical": "crm"} }'
```

The document is stored (content-hash deduped, PII-redacted, chunked), read by
the generalist indexer — plus any Domain Pack that opted into a **dedicated
run** and matched the relevance router — staged as candidates you can audit at
`GET /v1/documents/:id/candidates`, and only then committed through the same
conflict-resolution ladder as every other fact. Connectors own raw formats
(PDF, email, chat exports); Brain owns understanding what was read.

What that buys:

- **Composable indexers.** Every pack's facts are attributed by predicate
  namespace out of the union extraction call at zero extra LLM cost; packs
  that need their own prompt budget or model declare
  `indexer: { mode: "dedicated" }` in their manifest and are routed per
  document (`DOCUMENT_MULTI_INDEXER_ENABLED=1`).
- **Re-indexing.** Install a new pack and replay it over stored documents —
  `POST /v1/admin/documents/reindex` or automatically with
  `REINDEX_ON_PACK_INSTALL=1`. The run ledger skips whatever a pack version
  already processed.
- **Honest corroboration.** Facts carry `originKey = doc:<contentHash>`;
  agreement only counts as independent evidence when it comes from a
  *different document*, not a different reader of the same one.
- **A privacy dial.** `storeContent: false` keeps only the content hash and
  metadata — extraction still runs, but nothing to re-index or leak later.

## Build on Brain

Brain is a platform, not just a service: third parties extend the ontology,
the ingestion plane, and the tool surface without a PR to this repo.

- **Author a Domain Pack.** `pnpm pack:init` scaffolds a valid manifest;
  edit → `pack:validate` → `pack:sign` (ed25519) → `pack:publish` →
  `pack:install`. A pack is JSON — no compiled module, no fork.
  [Domain Packs](docs/domain-packs.md).
- **Publish to the global registry.** Immutable versions, yank-not-delete,
  verified-publisher badges, download counters, and pull-only cross-instance
  mirroring (`REGISTRY_UPSTREAM_URL`). Public catalogue at `GET /registry/ui`.
  [Registry](docs/domain-packs.md#the-registry-global-catalogue).
- **Sell it on the marketplace.** Hosting instances can feature packs, render
  publisher profiles, and price packs through the central billing service —
  the entitlement `domain_pack:<packId>` gates the install, and a refused
  install is a self-describing 402 with the checkout path. Billing off =
  everything installs free. [Marketplace](docs/domain-packs.md#marketplace).
- **Run an external indexer.** A plain HTTP client polls for routed documents,
  claims a lease, reads stored text, and submits candidate facts that Brain
  re-grounds and adjudicates. Protocol: [indexer-protocol.md](docs/indexer-protocol.md);
  dependency-free reference client: [`examples/reference-indexer.ts`](examples/reference-indexer.ts)
  (`pnpm indexer:reference`).
- **Declare MCP tools.** Packs contribute query tools over their own
  predicates or HMAC-proxied external tools, installed only with explicit
  operator consent (`acceptMcpTools`). [MCP pack tools](docs/mcp-pack-tools.md).
- **Ship knowledge with the pack.** `seedDocuments` in the manifest are
  ingested through the normal document pipeline on install — same chunking,
  staging, conflict resolution, and provenance as any connector's document.
  [Seed documents](docs/domain-packs.md#seed-documents-consumed).

The platform surface is machine-described in
[`docs/openapi.json`](docs/openapi.json) (OpenAPI 3.1, regenerate with
`pnpm openapi:build`).

## Quality (latest gate run)

```
recall@1                 0.962  [0.94–0.98]   n=262
recall@3                 0.989  [0.97–1.00]   n=262
MRR                      0.976  [0.96–0.99]   n=262
NDCG@10                  0.973  [0.96–0.99]
identity-resolution-f1   1.000
pii-gating-correctness   1.000
memory-lifecycle         1.000
faithfulness pass-rate   1.000  n=3
```

CI floors: recall@1 ≥ 0.6, recall@3 ≥ 0.8, MRR ≥ 0.5, identity-F1 ≥ 0.8,
pii-gating = 1.0, memory-lifecycle = 1.0, faithfulness ≥ 0.8. Bootstrap-CI on
every retrieval metric, with a per-predicate breakdown and per-vertical +
temporal/current split in the report. Numbers from the multi-vertical scenario
suite plus 180 wikidata queries (90 Latin + 90 Cyrillic).
Methodology: [`docs/eval.md`](docs/eval.md).

## Stack

NestJS 11 + TypeScript on Node 22 · SurrealDB 3.x (HNSW + BM25, one database
per tenant) · BGE-M3 embeddings (ONNX, runs locally in a worker thread) ·
OpenAI `gpt-4o-mini` for extraction / synthesize / verifier · optional Cohere
Rerank or a local ONNX cross-encoder · a SurrealDB-native job queue ·
OpenTelemetry. CPU-heavy work (embeddings, cross-encoder, NLI intent routing,
local NER, label propagation, token counting) runs in `worker_threads` so the
event loop keeps serving HTTP, and `PROCESS_ROLE=api|worker` splits one image
into an HTTP pod and a jobs pod when a deployment outgrows a single process.
Ships as a Docker image; runs on any host.

## Documentation

The hub with per-persona routing lives at [`docs/README.md`](docs/README.md).

| | |
|---|---|
| **Get going** | [Getting started](docs/getting-started.md) · [Migration guide](docs/migration-guide.md) |
| **Understand it** | [Architecture](docs/architecture.md) · [API reference](docs/api.md) · [OpenAPI 3.1 spec](docs/openapi.json) (platform surface, generated) · [Data model](docs/data-model.md) · [Bitemporal semantics](docs/bitemporal-semantics.md) · [Source reputation & trust](docs/source-reputation.md) · [ABAC access policies](docs/abac.md) · [Document pipeline](docs/document-pipeline.md) |
| **Extend it** | [Domain Packs](docs/domain-packs.md) (registry + marketplace + seed documents) · [External indexer protocol](docs/indexer-protocol.md) · [MCP pack tools](docs/mcp-pack-tools.md) · [Listing playbook](docs/distribution.md) · [Code memory](docs/roadmap/code-memory-domain.md) |
| **Run it** | [Operations](docs/operations.md) · [Operator playbook](docs/operator-playbook.md) · [Deploy runbook](docs/DEPLOY.md) |
| **Measure it** | [Eval harness](docs/eval.md) · [LoCoMo benchmark](docs/locomo.md) |

A reader-friendly version of the docs lives at
**[brain.inite.ai/en/docs](https://brain.inite.ai/en/docs)** (also in Russian).

## Contributing

PRs are welcome — from typo fixes to new retrieval legs. Good first issues are
tagged [`good first issue`](https://github.com/inite-ai/inite-brain-service/issues?q=is%3Aopen+label%3A%22good+first+issue%22).

```bash
pnpm install
docker compose up -d surrealdb
cp .env.example .env          # OPENAI_API_KEY needed for ingest/search
pnpm start:dev                # run the service
pnpm test                     # unit tests — must pass before a PR
pnpm test:eval                # retrieval-quality eval (needs an OpenAI key)
```

Two hard bars for every PR: **tests + the eval gate pass** (a retrieval
regression past tolerance blocks merge), and **schema changes ship as new
numbered migrations** in `src/db/migrations/`. Details in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Please also read the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Found a vulnerability? Don't open a
public issue — see [`SECURITY.md`](SECURITY.md).

## Roadmap

Shipped: bitemporal graph, hybrid retrieval pipeline, conflict resolution,
domain-scoped source reputation + cross-source corroboration + a read-only
trust-inputs API, identity merge, GDPR forget, native MCP, per-key ABAC
policy sets, the document pipeline with an external-indexer protocol
(pull work API + signed webhook hints + reference client), Domain Packs
(industry library, signed global registry with verified badges, download
counters and pull-only mirroring, marketplace with paid packs, pack-declared
MCP tools, seed documents), OpenAPI 3.1 platform spec, worker-thread offloads
+ `PROCESS_ROLE` api/worker split, code memory (record *why* a decision was
made, drift-resistant symbol anchors), eval-gated CI, off-hours
self-improvement (dreams).

Exploring (issues + ideas welcome): extractor span-grounding offload (profile
first), worker-pool right-sizing as more handlers move to threads, and the
full paid LoCoMo run with published numbers. Temporal was evaluated and
deliberately not adopted — the re-evaluation triggers live in
[docs/roadmap/platform-gap-2026-07.md](docs/roadmap/platform-gap-2026-07.md).
Have a use case? Open an issue.

## License

[AGPL-3.0-or-later](LICENSE). Brain is a hosted backend service, so AGPL is the
honest choice: if you run Brain (modified or not) for users over a network, you
make the corresponding source available to them under the same terms. If AGPL is
incompatible with your downstream needs, open an issue — we may relicense specific
modules when the request is reasonable.
