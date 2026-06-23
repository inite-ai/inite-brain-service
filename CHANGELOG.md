# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Topic communities** — the entity graph is now clustered into topic
  communities (label propagation over `knowledge_edge`, borrowed from
  graphiti). Each community carries a rolled-up summary + embedding and is
  exposed as a coarse retrieval scope via the MCP tools `search_communities`,
  `list_communities`, and `find_entity_communities`. Built off-hours by the
  dreams loop (`communities` op, gated by `DREAMS_COMMUNITIES_ENABLED`).
- **Watermark summarisation cache** — `summarize_entity` now invalidates its
  cache by a dual wall-clock / event-time watermark (graphiti `summarize_saga`
  pattern). A backfilled fact (newer `recordedAt`, past `validFrom`) correctly
  busts the cache, and results carry `asOfValid` — the event-time the summary
  reflects. Community summaries reuse the same watermark to skip rebuilding
  unchanged clusters.
- **Inline entity resolution at ingest** (opt-in, graphiti-style) — on the
  free-text mention path, before minting a new entity for an extracted name
  that missed the exact-name match, brain now cosine-searches existing
  entities and lets an LLM judge confirm same-as using the incoming mention's
  freshly-extracted facts. A confirmed match reuses the existing entity, so
  the near-duplicate is never created (narrows the dedup window that
  previously waited for the off-hours dreams pass). The judge prefers
  "different" when unsure — wrongly fusing two distinct entities (e.g. two
  "John Smith"s) is worse than a transient duplicate dreams can still merge.
  Gated by `INGEST_INLINE_RESOLUTION_ENABLED` (default off); any error or
  timeout falls back to create-new and never blocks ingest. Structured
  `POST /v1/ingest/fact` with an explicit `vertical:id` is untouched.

## [0.1.0] — 2026-06-23

First public open-source release.

### Added

- **Bitemporal knowledge graph** — every fact carries valid time and
  transaction time; query `now` or replay any past state via `asOf`.
- **Hybrid retrieval pipeline** — vector + BM25 fusion, HyPE, predicate
  router, graph edge-expansion, tier-aware PPR, cross-encoder, and a listwise
  LLM reranker with self-consistency. Each stage is a per-tenant feature flag.
- **Conflict-aware ingest** — scored resolution ladder with
  `INSERTED` / `COMPETING` / `SUPERSEDED` / `REJECTED` outcomes and a
  dead-letter table.
- **Memory lifecycle** — retract (auditable) and a synchronous GDPR forget
  cascade that leaves only an HMAC tombstone.
- **Identity resolution** — cross-vertical entity merge via `identity_of`.
- **Native MCP** — per-tenant Streamable HTTP endpoint with six scope-aware
  tools, plus four Anthropic-format agent skills.
- **Eval-gated CI** — multi-vertical retrieval + memory-lifecycle suite with
  bootstrap CIs; regressions past tolerance block merges.
- **Website** — marketing landing, bilingual (EN/RU) docs and blog, dynamic
  OG images, full SEO/AEO surface (robots, sitemap, llms.txt, ai.txt,
  agent-actions, JSON-LD) at [brain.inite.ai](https://brain.inite.ai).

### License

- AGPL-3.0-or-later.

[0.1.0]: https://github.com/inite-ai/inite-brain-service/releases/tag/v0.1.0
