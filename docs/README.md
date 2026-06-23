# Documentation

Brain documentation — grouped by what you're trying to do, not by
which file the bits used to live in.

## For new users

| Doc | Purpose |
|---|---|
| [Getting started](getting-started.md) | Run brain locally in five commands. Seed an ApiKey. Smoke test. |
| [Migration guide](migration-guide.md) | Wire a vertical into brain via the `@inite/knowledge` SDK. |

## For developers

| Doc | Purpose |
|---|---|
| [Architecture](architecture.md) | Retrieval pipeline, multi-hop planner, synthesize guardrail, dreams + job queue. |
| [API reference](api.md) | Every v1 endpoint with notes + auth scopes. |
| [Data model](data-model.md) | Bitemporal facts, predicate vocabulary, conflict resolution, tenancy, PII / GDPR. |
| [Bitemporal semantics — deep dive](bitemporal-semantics.md) | Default-now search, Allen's interval algebra, why not just post-filter. |
| [Eval harness](eval.md) | Production-gate retrieval + lifecycle eval. Load your CRM via JSON or Wikidata. |
| [LoCoMo benchmark](locomo.md) | Long-term conversational memory eval — apples-to-apples vs Mem0 / Zep / MemGPT. |

## For operators

| Doc | Purpose |
|---|---|
| [Operations](operations.md) | All env vars, retrieval feature flags, queue tuning, boot validation, test commands. |
| [Operator playbook](operator-playbook.md) | Issue an ApiKey, troubleshoot ingest / search, run a GDPR forget, drain a stuck queue. |
| [Deploy runbook](DEPLOY.md) | Production deploy — Traefik, GitHub Actions, rollback. |
| [Distribution playbook](distribution.md) | Where to list brain — MCP Registry, awesome-* PRs, with ready-to-paste rows. |

## Roadmap

- [MCP + memory next steps](roadmap/mcp-and-memory.md) — planned work: memory_diff / procedural memory / MCP resources / ClaudeMcpAgent + full LoCoMo run

## Cross-cutting

- [License](../LICENSE) — AGPL-3.0-or-later
- [Security policy](../SECURITY.md) — private channel for vulnerabilities
- [Contributing guide](../CONTRIBUTING.md) — PR bars, commit style, release model
