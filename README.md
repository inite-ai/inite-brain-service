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

NestJS 11 + TypeScript on Node 22 · SurrealDB 2.3 (HNSW + BM25, one database
per tenant) · BGE-M3 embeddings (ONNX, runs locally in a worker thread) ·
OpenAI `gpt-4o-mini` for extraction / synthesize / verifier · optional Cohere
Rerank · a SurrealDB-native job queue · OpenTelemetry. Ships as a Docker image;
runs on any host.

## Documentation

| | |
|---|---|
| **Get going** | [Getting started](docs/getting-started.md) · [Migration guide](docs/migration-guide.md) |
| **Understand it** | [Architecture](docs/architecture.md) · [API reference](docs/api.md) · [Data model](docs/data-model.md) · [Bitemporal semantics](docs/bitemporal-semantics.md) |
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
identity merge, GDPR forget, native MCP, eval-gated CI, off-hours self-improvement
(dreams).

Exploring (issues + ideas welcome): HNSW on by default for large tenants,
multi-hop edge-expansion by default, a local cross-encoder fallback, per-leg
OpenTelemetry spans, and an embedding-upgrade path. Have a use case? Open an issue.

## License

[AGPL-3.0-or-later](LICENSE). Brain is a hosted backend service, so AGPL is the
honest choice: if you run Brain (modified or not) for users over a network, you
make the corresponding source available to them under the same terms. If AGPL is
incompatible with your downstream needs, open an issue — we may relicense specific
modules when the request is reasonable.
