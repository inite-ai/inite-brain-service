# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.3.0](https://github.com/inite-ai/inite-brain-service/compare/v0.2.0...v0.3.0) (2026-06-29)


### Features

* **code-memory:** Phase 0 — record_decision/why MCP tools + code-decision predicate pack ([#71](https://github.com/inite-ai/inite-brain-service/issues/71)) ([ee903f4](https://github.com/inite-ai/inite-brain-service/commit/ee903f47216dee67d89ce31f267850409c67fca9))
* **code-memory:** Phase 1 — hybrid client-side decision capture (layered gate + LLM extract) ([#72](https://github.com/inite-ai/inite-brain-service/issues/72)) ([75a1ac0](https://github.com/inite-ai/inite-brain-service/commit/75a1ac097f73e5e97faa842240819ed32ba64b83))
* **domain-packs:** pluggable versioned ontology pack standard + namespacing (code-memory becomes pack [#1](https://github.com/inite-ai/inite-brain-service/issues/1)) ([#73](https://github.com/inite-ai/inite-brain-service/issues/73)) ([d035661](https://github.com/inite-ai/inite-brain-service/commit/d035661f32594d40993118f3c5a90651e2620f01))
* **ops:** observability + deploy resilience ([#30](https://github.com/inite-ai/inite-brain-service/issues/30)) ([8b04244](https://github.com/inite-ai/inite-brain-service/commit/8b04244b65c7aa8b4e1a65b359fa8bfc7575bde1))
* **security:** auth hardening, body limits, worker-pool self-heal & correctness fences ([#27](https://github.com/inite-ai/inite-brain-service/issues/27)) ([a89c625](https://github.com/inite-ai/inite-brain-service/commit/a89c625d96181574f31fed7771a6d564baebd475))


### Bug Fixes

* **communities:** deterministic fact order so community summaries are reproducible ([#32](https://github.com/inite-ai/inite-brain-service/issues/32)) ([48c4f7b](https://github.com/inite-ai/inite-brain-service/commit/48c4f7b9421dd68d56eafa3a4cae9ce627f6cf3b))
* **jobs:** make JobDispatcherService.dispatchBody take an options object (max-params) ([#66](https://github.com/inite-ai/inite-brain-service/issues/66)) ([a1211e8](https://github.com/inite-ai/inite-brain-service/commit/a1211e8187baec5efca8313dd5b577b736d527a0))
* **synthesize:** resolve inline + prefix-drifted citations (citation-rate) ([#42](https://github.com/inite-ai/inite-brain-service/issues/42)) ([196a9b1](https://github.com/inite-ai/inite-brain-service/commit/196a9b176db54c2e2817d811b01b92081fca6d2f))
* **test:** migrate runner-driven specs off the SDK to HttpBrainClient ([#45](https://github.com/inite-ai/inite-brain-service/issues/45)) ([a4564bd](https://github.com/inite-ai/inite-brain-service/commit/a4564bdbab564406e0911e528bf24f3e06d18a38))

## [0.2.0](https://github.com/inite-ai/inite-brain-service/compare/v0.1.0...v0.2.0) (2026-06-25)


### Features

* **app:** end-user memory UI with Explore/Develop console ([#26](https://github.com/inite-ai/inite-brain-service/issues/26)) ([fb5b27e](https://github.com/inite-ai/inite-brain-service/commit/fb5b27e0250aaf71d09e8fa5a430bf10e0349d97))
* **db:** move identity-merge, zombie-reap & locale tagging into SurrealDB functions ([#23](https://github.com/inite-ai/inite-brain-service/issues/23)) ([680e814](https://github.com/inite-ai/inite-brain-service/commit/680e814f468f16b3fa6b45cd7e9d7a0eb980a4f7))
* **ingest:** inline entity resolution at write time ([#21](https://github.com/inite-ai/inite-brain-service/issues/21)) ([9758ec8](https://github.com/inite-ai/inite-brain-service/commit/9758ec8c56fdf7bbd7017a027e29a6a4d96a0ed6))
* topic communities + watermark summarisation ([#20](https://github.com/inite-ai/inite-brain-service/issues/20)) ([704eb08](https://github.com/inite-ai/inite-brain-service/commit/704eb08c271183c43e19d8dd95d85b9a74f69656))


### Bug Fixes

* **brain-mcp:** explicit types:[node] so it builds under TypeScript 6 ([b247d1f](https://github.com/inite-ai/inite-brain-service/commit/b247d1f52f1b06b620075e3ff74c04eace6ca3a3))
* **db:** SurrealDB 3.x runtime gaps surfaced by full-Docker boot ([#25](https://github.com/inite-ai/inite-brain-service/issues/25)) ([3fb39a3](https://github.com/inite-ai/inite-brain-service/commit/3fb39a3d6a1a7c44bf4f3d92891b0fe281635a20))

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
