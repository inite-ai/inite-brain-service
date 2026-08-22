# Documentation

The hub for everything in `docs/` — grouped by what you're trying to do,
with one row per document.

**Where do I start?**

- **Using Brain from an app or agent** → [Getting started](getting-started.md),
  then the [API reference](api.md).
- **Understanding how it works** → [Architecture](architecture.md), then
  [Data model](data-model.md) and [Bitemporal semantics](bitemporal-semantics.md).
- **Building on the platform** (packs, indexers, tools) →
  [Domain Packs](domain-packs.md) and the
  [External indexer protocol](indexer-protocol.md).
- **Running it in production** → [Operations](operations.md) and the
  [Operator playbook](operator-playbook.md).

## Use it

| Doc | Purpose |
|---|---|
| [Getting started](getting-started.md) | Run Brain locally in five commands, seed an ApiKey, smoke test. |
| [Migration guide](migration-guide.md) | Wire a vertical into Brain via the `@inite/knowledge` SDK. |
| [API reference](api.md) | Every v1 endpoint with notes + auth scopes, grouped by area. |
| [OpenAPI 3.1 spec](openapi.json) | Machine-readable platform surface. Generated — regenerate with `pnpm openapi:build`, never edit by hand. |

## Understand it

| Doc | Purpose |
|---|---|
| [Architecture](architecture.md) | Retrieval pipeline, multi-hop planner, synthesize guardrail, dreams + job queue, worker threads, MCP surface. |
| [Data model](data-model.md) | Bitemporal facts, predicate vocabulary, conflict resolution, tenancy, PII / GDPR. |
| [Bitemporal semantics](bitemporal-semantics.md) | Default-now search, Allen's interval algebra, why not just post-filter. |
| [Source reputation & trust](source-reputation.md) | Domain-scoped trust, corroboration, feedback loop, trust in ranking. |
| [ABAC access policies](abac.md) | Per-key policy sets: action gating + row-level read filtering, rollout runbook. |
| [Document pipeline](document-pipeline.md) | Source → Indexer → Candidates → Brain: composable indexers, staged candidates, origin-keyed corroboration, re-indexing, external indexers, seed documents. |
| [Fact provenance API](fact-provenance-api.md) | `GET /v1/facts/:id` + `/provenance` — the fact and the verbatim turns it came from ("show me why I remember this"). Flag-gated, ownership-fenced. |
| [User profile API](user-profile-api.md) | `GET /v1/users/:userId/profile` — deterministic, prompt-ready assembly of one user's own memory (strict user scope). Flag-gated. |
| [Eval harness](eval.md) | Production-gate retrieval + lifecycle eval. Load your CRM via JSON or Wikidata. |
| [LoCoMo benchmark](locomo.md) | Long-term conversational memory eval — apples-to-apples vs Mem0 / Zep / MemGPT. |

## Build on it

Platform and community extension points — none require a PR to this repo.

| Doc | Purpose |
|---|---|
| [Domain Packs](domain-packs.md) | The ontology extension standard: manifest reference, authoring quickstart, registry, marketplace, seed documents. |
| [External indexer protocol](indexer-protocol.md) | Build a service that reads stored documents and submits candidate facts: poll → claim → content → submit. |
| [MCP pack tools](mcp-pack-tools.md) | Packs extending the tenant MCP surface: query tools + HMAC-proxied external tools, consent flow, security model. |
| [`examples/reference-indexer.ts`](../examples/reference-indexer.ts) | Dependency-free reference external indexer (`pnpm indexer:reference`). |
| [Listing playbook](distribution.md) | Where to list Brain itself — MCP Registry, awesome-list PRs, ready-to-paste rows. |
| [Code memory](roadmap/code-memory-domain.md) | The `code_memory` Domain Pack: remembering the *why* of a codebase. |
| [Distillation dataset](code-memory/distillation-dataset.md) | Data plan + harness for the trained code-memory decision gate. |

## Operate it

| Doc | Purpose |
|---|---|
| [Operations](operations.md) | All env vars, feature flags, queue tuning, role split, enablement runbooks, test commands. |
| [Operator playbook](operator-playbook.md) | Issue an ApiKey, troubleshoot ingest / search, run a GDPR forget, drain a stuck queue. |
| [Deploy runbook](DEPLOY.md) | Production deploy — Traefik, GitHub Actions, rollback, observability. |

## Roadmap

- [Platform gap analysis — July 2026](roadmap/platform-gap-2026-07.md) — the
  **current** roadmap document: where the platform stands, the Temporal
  not-adopted decision (+ re-evaluation triggers), and the residual backlog.
- Historical planning records (kept as a record of what was built, not TODOs):
  [mcp-and-memory.md](roadmap/mcp-and-memory.md) (self-labelled ~95% shipped),
  [next-session-2026-07.md](roadmap/next-session-2026-07.md),
  [next-session-2026-07b.md](roadmap/next-session-2026-07b.md),
  [audit-followup-2026-06.md](roadmap/audit-followup-2026-06.md),
  [max-params-and-remainder-2026-06.md](roadmap/max-params-and-remainder-2026-06.md).

## Cross-cutting

- [License](../LICENSE) — AGPL-3.0-or-later
- [Security policy](../SECURITY.md) — private channel for vulnerabilities
- [Contributing guide](../CONTRIBUTING.md) — PR bars, commit style, Domain Pack recipe
