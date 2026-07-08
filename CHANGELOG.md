# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.3.0](https://github.com/inite-ai/inite-brain-service/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* **code-memory:** external-corpus labeler + confidence gate for the decision gate (track C) ([#105](https://github.com/inite-ai/inite-brain-service/issues/105)) ([7b2e9fa](https://github.com/inite-ai/inite-brain-service/commit/7b2e9fa5340e92fc78c63c4fae252ed61b4f805b))
* **code-memory:** multi-label kinds heads + frozen golden eval for the gate (track C) ([#110](https://github.com/inite-ai/inite-brain-service/issues/110)) ([b12233f](https://github.com/inite-ai/inite-brain-service/commit/b12233fecbc3eec328301d05299964761946fd8d))
* **code-memory:** Phase 0 — record_decision/why MCP tools + code-decision predicate pack ([#71](https://github.com/inite-ai/inite-brain-service/issues/71)) ([ee903f4](https://github.com/inite-ai/inite-brain-service/commit/ee903f47216dee67d89ce31f267850409c67fca9))
* **code-memory:** Phase 1 — hybrid client-side decision capture (layered gate + LLM extract) ([#72](https://github.com/inite-ai/inite-brain-service/issues/72)) ([75a1ac0](https://github.com/inite-ai/inite-brain-service/commit/75a1ac097f73e5e97faa842240819ed32ba64b83))
* **code-memory:** Phase 2 — drift-resistant symbol anchors (SCIP-style) + grounding + validation ([#86](https://github.com/inite-ai/inite-brain-service/issues/86)) ([4509ebc](https://github.com/inite-ai/inite-brain-service/commit/4509ebc239539470dc8b36d7c495a2f78de64f8a))
* **code-memory:** Phase 2b — anchor re-validation sweep (list/reanchor/invalidate) ([#89](https://github.com/inite-ai/inite-brain-service/issues/89)) ([0ed5bcf](https://github.com/inite-ai/inite-brain-service/commit/0ed5bcf14a53382859c52efe80cb6a236cc21164))
* **code-memory:** Phase 3 — eval gate (recall + invariant surfacing) + metrics + golden ([#87](https://github.com/inite-ai/inite-brain-service/issues/87)) ([386bc27](https://github.com/inite-ai/inite-brain-service/commit/386bc272f07e98c6d3dcb920773a08aa1a4168a5))
* **code-memory:** Phase 3b — semantic recall leg + recall_decisions MCP tool ([#88](https://github.com/inite-ai/inite-brain-service/issues/88)) ([0a7423d](https://github.com/inite-ai/inite-brain-service/commit/0a7423d4a26bda5067f766b8cf234b8816821a9d))
* **code-memory:** ship a default gate model + hybrid gate as the default (track C) ([#111](https://github.com/inite-ai/inite-brain-service/issues/111)) ([3a179f3](https://github.com/inite-ai/inite-brain-service/commit/3a179f3510a1f6dc5860ac9e541c10bf046bc8bd))
* **code-memory:** silver-dataset harness for the trained Layer-1 gate (track C) ([#101](https://github.com/inite-ai/inite-brain-service/issues/101)) ([5b3ddb3](https://github.com/inite-ai/inite-brain-service/commit/5b3ddb34c93ccc4f80657cadab5649cd8c232370))
* **code-memory:** teacher verification (LLM-judge) — a stronger teacher for track C ([#107](https://github.com/inite-ai/inite-brain-service/issues/107)) ([0418868](https://github.com/inite-ai/inite-brain-service/commit/0418868fdea68c06e445c66b2f196eb9e963755a))
* **code-memory:** trained Layer-1 decision gate — student model, train + serve (track C) ([#103](https://github.com/inite-ai/inite-brain-service/issues/103)) ([0b2ee11](https://github.com/inite-ai/inite-brain-service/commit/0b2ee11f5a0656fdcb73adcc30034be93de0a276))
* **domain-packs:** consume evalFixtures — run a pack's eval cases against the live extractor ([#108](https://github.com/inite-ai/inite-brain-service/issues/108)) ([9b6cb71](https://github.com/inite-ai/inite-brain-service/commit/9b6cb71a62569c1b3761f1ca7cda2c0dbf19c7d7))
* **domain-packs:** consume extractionProfile via real_estate — the second pack ([#93](https://github.com/inite-ai/inite-brain-service/issues/93)) ([7f3d128](https://github.com/inite-ai/inite-brain-service/commit/7f3d128c797d9eb48c92cf4303067df001462df3))
* **domain-packs:** distribution — JSON-manifest install CLI + content-integrity checksum ([#90](https://github.com/inite-ai/inite-brain-service/issues/90)) ([edbec28](https://github.com/inite-ai/inite-brain-service/commit/edbec28fc3ba25ca10522b052bdc2df3d3fd7413))
* **domain-packs:** industry pack library — fintech, medical, legal ([#112](https://github.com/inite-ai/inite-brain-service/issues/112)) ([ae8f6ff](https://github.com/inite-ai/inite-brain-service/commit/ae8f6fffbc3ac71e4acdf3839b85f997c0e9849c))
* **domain-packs:** more industry packs — insurance, hr ([#114](https://github.com/inite-ai/inite-brain-service/issues/114)) ([1bee640](https://github.com/inite-ai/inite-brain-service/commit/1bee64063a83951bbdc24c69b748bc1061190b8d))
* **domain-packs:** pluggable versioned ontology pack standard + namespacing (code-memory becomes pack [#1](https://github.com/inite-ai/inite-brain-service/issues/1)) ([#73](https://github.com/inite-ai/inite-brain-service/issues/73)) ([d035661](https://github.com/inite-ai/inite-brain-service/commit/d035661f32594d40993118f3c5a90651e2620f01))
* **domain-packs:** publisher signatures — ed25519 sign/verify + install trust policy ([#91](https://github.com/inite-ai/inite-brain-service/issues/91)) ([891fd40](https://github.com/inite-ai/inite-brain-service/commit/891fd40e2fcf4eeed69e75b7a3587ccd8285aa59))
* **domain-packs:** runtime per-tenant pack install/uninstall (admin API + migration) ([#85](https://github.com/inite-ai/inite-brain-service/issues/85)) ([27ad717](https://github.com/inite-ai/inite-brain-service/commit/27ad717a4bc6b307c61ce80c49e291b814953f61))
* **ops:** observability + deploy resilience ([#30](https://github.com/inite-ai/inite-brain-service/issues/30)) ([8b04244](https://github.com/inite-ai/inite-brain-service/commit/8b04244b65c7aa8b4e1a65b359fa8bfc7575bde1))
* **registry:** CLIs, first-party seed, and docs for the pack registry ([#97](https://github.com/inite-ai/inite-brain-service/issues/97)) ([3c25b50](https://github.com/inite-ai/inite-brain-service/commit/3c25b50e02c5357ca086a87e62bc9c9b63557548))
* **registry:** global Domain Pack registry — publish, discover, install-from-registry ([#96](https://github.com/inite-ai/inite-brain-service/issues/96)) ([9807870](https://github.com/inite-ai/inite-brain-service/commit/9807870217c50229ecb390b426fd0416d4a7ce2a))
* **registry:** public server-rendered registry UI (GET /registry/ui) ([#115](https://github.com/inite-ai/inite-brain-service/issues/115)) ([a07ddc4](https://github.com/inite-ai/inite-brain-service/commit/a07ddc4bb93c8fa0bd227e164712e165432e6ace))
* **security:** auth hardening, body limits, worker-pool self-heal & correctness fences ([#27](https://github.com/inite-ai/inite-brain-service/issues/27)) ([a89c625](https://github.com/inite-ai/inite-brain-service/commit/a89c625d96181574f31fed7771a6d564baebd475))
* **trust:** cross-source corroboration — agreement strengthens instead of dueling (source-reputation phase 4) ([#121](https://github.com/inite-ai/inite-brain-service/issues/121)) ([dd6543e](https://github.com/inite-ai/inite-brain-service/commit/dd6543ed38353fad6e4e5469186db97869620e11))
* **trust:** domain-scoped source reputation + history trail (source-reputation phase 2) ([#119](https://github.com/inite-ai/inite-brain-service/issues/119)) ([2e4fd9c](https://github.com/inite-ai/inite-brain-service/commit/2e4fd9c17fe936ce0916f2e6afd0a50f2e702c19))
* **trust:** fact_trust at read time — trust moves rankings, with a stored "because" (source-reputation phase 5) ([#122](https://github.com/inite-ai/inite-brain-service/issues/122)) ([cfe51e2](https://github.com/inite-ai/inite-brain-service/commit/cfe51e2d5979b9e7bea1b9aed7fd4bd775aa3b48))
* **trust:** persist trust snapshot + conflict trace on facts, evidence[] in source (source-reputation phase 1) ([#118](https://github.com/inite-ai/inite-brain-service/issues/118)) ([51d23b0](https://github.com/inite-ai/inite-brain-service/commit/51d23b0cc2295d4b8e2baf797a40f82be5a9a171))
* **trust:** source registry + authority activation + reputation read APIs (source-reputation phase 3) ([#120](https://github.com/inite-ai/inite-brain-service/issues/120)) ([ca06ff6](https://github.com/inite-ai/inite-brain-service/commit/ca06ff6f505d6059c8ffaaf041781eee1ebe8570))


### Bug Fixes

* **audit:** wave-1 hotfixes — MCP scope gates, backdated supersede, eval watchdog, cache poisoning ([#117](https://github.com/inite-ai/inite-brain-service/issues/117)) ([85587bb](https://github.com/inite-ai/inite-brain-service/commit/85587bba8238ef6b58b0a9137363f9d0aa9bce40))
* **code-memory:** sweep blast-radius guard, resolver ext-gate, reanchor threshold, gate ratchet, sink timeout (audit wave 4) ([#128](https://github.com/inite-ai/inite-brain-service/issues/128)) ([58138d6](https://github.com/inite-ai/inite-brain-service/commit/58138d687d5b6546a786adbf6f353d4f0f2ce4be))
* **communities:** deterministic fact order so community summaries are reproducible ([#32](https://github.com/inite-ai/inite-brain-service/issues/32)) ([48c4f7b](https://github.com/inite-ai/inite-brain-service/commit/48c4f7b9421dd68d56eafa3a4cae9ce627f6cf3b))
* **domain-packs:** apply pack-upgrade diff + fold profiles into versionHash (audit wave 2) ([#125](https://github.com/inite-ai/inite-brain-service/issues/125)) ([36f602a](https://github.com/inite-ai/inite-brain-service/commit/36f602a4bc9a0360fdc1e154cade0df6b155859b))
* **domain-packs:** cap pack-eval fixtures + throttle the eval route (audit H7) ([#127](https://github.com/inite-ai/inite-brain-service/issues/127)) ([c2070c2](https://github.com/inite-ai/inite-brain-service/commit/c2070c23610b82ba9ae5465146f3a77c66144a54))
* **domain-packs:** reinstall reactivation + validate enums + reject downgrade (audit wave 2) ([#124](https://github.com/inite-ai/inite-brain-service/issues/124)) ([33b2b16](https://github.com/inite-ai/inite-brain-service/commit/33b2b168bbaacd06abb837db6eb3e1c0ecdb1f0e))
* **eval:** CI-aware delta-gate — widen tolerance by the baseline's own bootstrap band ([#123](https://github.com/inite-ai/inite-brain-service/issues/123)) ([d543ca1](https://github.com/inite-ai/inite-brain-service/commit/d543ca1a86f402b8a208dc77f9e7a6092231260b))
* **jobs:** make JobDispatcherService.dispatchBody take an options object (max-params) ([#66](https://github.com/inite-ai/inite-brain-service/issues/66)) ([a1211e8](https://github.com/inite-ai/inite-brain-service/commit/a1211e8187baec5efca8313dd5b577b736d527a0))
* **ops/ci/docs:** shutdown ordering, snapshot herd dedup, strict lint:ci, docker-smoke 3.1.5, dead script, MCP doc counts (audit wave 5) ([#129](https://github.com/inite-ai/inite-brain-service/issues/129)) ([4ac528b](https://github.com/inite-ai/inite-brain-service/commit/4ac528bfa96e50f13d5b56040f7af339f9cf328b))
* **registry:** publish-race retry, builtin squatting, projection, pagination, esc coerce (audit wave 3) ([#126](https://github.com/inite-ai/inite-brain-service/issues/126)) ([9d5cce2](https://github.com/inite-ai/inite-brain-service/commit/9d5cce2c3158cf339ea468ee6f460e7c7fd732c4))
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
