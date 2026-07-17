# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.8.1](https://github.com/inite-ai/inite-brain-service/compare/v0.8.0...v0.8.1) (2026-07-17)


### Bug Fixes

* **docs:** rename reserved mermaid node id 'graph' — README diagram failed to render ([#220](https://github.com/inite-ai/inite-brain-service/issues/220)) ([fa991ff](https://github.com/inite-ai/inite-brain-service/commit/fa991ff50a1047abfd948a1d03c1070fce2ab9ff))
* **security:** CodeQL-recognizable shapes — fromEntries summaries, typeof template guard ([#219](https://github.com/inite-ai/inite-brain-service/issues/219)) ([7a51da0](https://github.com/inite-ai/inite-brain-service/commit/7a51da0d48c167ff18066ceafe3566d4c4c9815d))

## [0.8.0](https://github.com/inite-ai/inite-brain-service/compare/v0.7.0...v0.8.0) (2026-07-17)


### Features

* **admin-ui:** packs, marketplace curation, and sources reputation panels ([#210](https://github.com/inite-ai/inite-brain-service/issues/210)) ([3bac9c4](https://github.com/inite-ai/inite-brain-service/commit/3bac9c461f86f8ffcf8717a9c105db125eb6c734))
* **admin-ui:** static registry API key path for marketplace writes ([#211](https://github.com/inite-ai/inite-brain-service/issues/211)) ([415928f](https://github.com/inite-ai/inite-brain-service/commit/415928f9af98d77e17be4b0f269d988c0b9a92b0))
* **auth:** inite-auth vertical tightening — per-user memory, agent grants, ABAC delivery ([#214](https://github.com/inite-ai/inite-brain-service/issues/214)) ([b4e95c8](https://github.com/inite-ai/inite-brain-service/commit/b4e95c8eb7db249b96607e4a72ef3e659c7c0cfd))
* **deploy:** enable marketplace billing and MCP pack query tools in prod ([#215](https://github.com/inite-ai/inite-brain-service/issues/215)) ([bccaa72](https://github.com/inite-ai/inite-brain-service/commit/bccaa7224e146250c600883fc32c4d51f07118cf))
* **mcp:** pack-declared MCP tools — query tools over pack predicates + HMAC-proxied external tools ([#204](https://github.com/inite-ai/inite-brain-service/issues/204)) ([24c697a](https://github.com/inite-ai/inite-brain-service/commit/24c697a3c401c47f259a7788d606db063017ad41))
* **packs:** seed documents — packs ship knowledge through the document pipeline ([#200](https://github.com/inite-ai/inite-brain-service/issues/200)) ([8e51dba](https://github.com/inite-ai/inite-brain-service/commit/8e51dbaa3ae96c9aa3a54270dfcef028a5cf3ef3))
* **registry:** marketplace — featured curation, publisher profiles, paid packs via billing service ([#202](https://github.com/inite-ai/inite-brain-service/issues/202)) ([aee950f](https://github.com/inite-ai/inite-brain-service/commit/aee950f9d411aff0f02a01f4994db346b338b38d))
* **sources:** read-only trust-inputs API under brain:read ([#199](https://github.com/inite-ai/inite-brain-service/issues/199)) ([3fc702d](https://github.com/inite-ai/inite-brain-service/commit/3fc702d2b3dec4782c2727ee7639e75d93c5f434))


### Bug Fixes

* **admin-ui:** config/jobs panel drift + in-repo drift guards ([#207](https://github.com/inite-ai/inite-brain-service/issues/207)) ([f6755dc](https://github.com/inite-ai/inite-brain-service/commit/f6755dc5bcb24231974e06ebc5c4a98b057998bc))
* **auth:** allow registry:curate on introspected operator keys ([#216](https://github.com/inite-ai/inite-brain-service/issues/216)) ([fe39a82](https://github.com/inite-ai/inite-brain-service/commit/fe39a8295cc50d2c2c1fbb20d88092ae3a534dbc))
* **db:** tolerate concurrent migration appliers racing the ledger insert ([#203](https://github.com/inite-ai/inite-brain-service/issues/203)) ([589c1e5](https://github.com/inite-ai/inite-brain-service/commit/589c1e5ca422833053f528a87baa5b0e76b509ab))
* **entities,app:** real transaction-time axis for profile/timeline + timeline event rendering ([#208](https://github.com/inite-ai/inite-brain-service/issues/208)) ([67935a8](https://github.com/inite-ai/inite-brain-service/commit/67935a8a9d12dbdb3b898c032aef0a0fa3da4db7))
* **release:** bump docs/openapi.json info.version in release PRs ([#217](https://github.com/inite-ai/inite-brain-service/issues/217)) ([d48b734](https://github.com/inite-ai/inite-brain-service/commit/d48b734fcd8fb217244fb5ef9737375fda7c1f3f))
* **security:** CodeQL backlog — linear email check, Map template dispatch, null-proto summaries; tolerant AI summary ([#218](https://github.com/inite-ai/inite-brain-service/issues/218)) ([4786648](https://github.com/inite-ai/inite-brain-service/commit/4786648e7d39042105e34e66db752dc58451b910))

## [0.7.0](https://github.com/inite-ai/inite-brain-service/compare/v0.6.2...v0.7.0) (2026-07-16)


### Features

* **api:** generated OpenAPI 3.1 spec for the platform surface ([#195](https://github.com/inite-ai/inite-brain-service/issues/195)) ([9b22f66](https://github.com/inite-ai/inite-brain-service/commit/9b22f6662087c17b60d0661f05adc062a6c0ce70))
* **auth:** per-pack binding for indexer:write keys ([#192](https://github.com/inite-ai/inite-brain-service/issues/192)) ([13576d1](https://github.com/inite-ai/inite-brain-service/commit/13576d1a82a61a65ecd49d7daf5bcc3bbd7e86e8))
* **documents:** signed webhook push hints for external indexers ([#193](https://github.com/inite-ai/inite-brain-service/issues/193)) ([2b01184](https://github.com/inite-ai/inite-brain-service/commit/2b01184ce87280f5084bf9688ebdb64f22d81328))
* **documents:** work-discovery pull API for external indexers ([#181](https://github.com/inite-ai/inite-brain-service/issues/181)) ([23ad966](https://github.com/inite-ai/inite-brain-service/commit/23ad966867063cedbdde2ac09d5e8186da02fda6))
* **observability:** self-hosted monitoring stack (VictoriaMetrics + Loki + Tempo + Alloy + Grafana) ([#165](https://github.com/inite-ai/inite-brain-service/issues/165)) ([75d0952](https://github.com/inite-ai/inite-brain-service/commit/75d095263626656b54939d3c63d9af7574930a5b))
* **ops:** PROCESS_ROLE api|worker|all split with compose recipe ([#190](https://github.com/inite-ai/inite-brain-service/issues/190)) ([0bf8bf9](https://github.com/inite-ai/inite-brain-service/commit/0bf8bf943ae555f1674202ff9d34bd74101344d3))
* **packs:** pack:init scaffold + authoring quickstart docs ([#185](https://github.com/inite-ai/inite-brain-service/issues/185)) ([b372573](https://github.com/inite-ai/inite-brain-service/commit/b372573e81b0d1cd59fb016e846d2bc83ed97368))
* **registry:** download counters and verified-publisher badge ([#186](https://github.com/inite-ai/inite-brain-service/issues/186)) ([a14d56d](https://github.com/inite-ai/inite-brain-service/commit/a14d56ddf87c6c4b6c64bb5dcf8793da50ac2c10))
* **registry:** pull-only cross-instance mirroring (REGISTRY_UPSTREAM_URL) ([#196](https://github.com/inite-ai/inite-brain-service/issues/196)) ([9123e64](https://github.com/inite-ai/inite-brain-service/commit/9123e64cfe1da5360ea9405c00b73ff587324f0c))


### Bug Fixes

* **db:** shape-aware transaction return slot — 2.x answers without BEGIN/COMMIT slots ([#175](https://github.com/inite-ai/inite-brain-service/issues/175)) ([9bfe05f](https://github.com/inite-ai/inite-brain-service/commit/9bfe05fdc26e86b800746e0e13353b004b1d16be))
* **deploy:** stop routing /metrics publicly + point OTLP at the monitoring collector ([#167](https://github.com/inite-ai/inite-brain-service/issues/167)) ([c6a865b](https://github.com/inite-ai/inite-brain-service/commit/c6a865bad8de88992d66a5843fb65c2e8a523d37))
* **jobs:** audit wave P1 — reaper lease guard, missing indexes, catalogue drift ([#176](https://github.com/inite-ai/inite-brain-service/issues/176)) ([c5d7c62](https://github.com/inite-ai/inite-brain-service/commit/c5d7c621f3139b1b5f6c1dd5a50b0e8e71d58104))
* **jobs:** point-read the lease record — end the leader_lease conflict storm ([#169](https://github.com/inite-ai/inite-brain-service/issues/169)) ([7610112](https://github.com/inite-ai/inite-brain-service/commit/7610112774c5a691489932b424d42f56ad0f46f7))
* **jobs:** single-arg type::record in lease SQL — 2-arg form is a cast on SurrealDB 2.x ([#170](https://github.com/inite-ai/inite-brain-service/issues/170)) ([bde4a29](https://github.com/inite-ai/inite-brain-service/commit/bde4a2906f040264fc1389840509cff293fdb17c))
* **jobs:** version-agnostic lease/claim deadlines — unblock background jobs in prod ([#166](https://github.com/inite-ai/inite-brain-service/issues/166)) ([ca45b36](https://github.com/inite-ai/inite-brain-service/commit/ca45b36bfdecf3c9216aa9280738c7e8b2aee58f))
* **search,mcp:** audit wave P2 — flag parser sweep, MCP hardening, unified closure, hot-path ([#177](https://github.com/inite-ai/inite-brain-service/issues/177)) ([bf14a38](https://github.com/inite-ai/inite-brain-service/commit/bf14a389fbbdf3a5750371bac91825a7374b32a0))
* **security:** resolve CodeQL findings, dependency alerts, and workflow hardening ([#198](https://github.com/inite-ai/inite-brain-service/issues/198)) ([01f5b49](https://github.com/inite-ai/inite-brain-service/commit/01f5b4914d6b5ea0c76bd29c122208ab8a7de225))


### Performance Improvements

* **admin:** move NLI intent classifier to a worker thread ([#182](https://github.com/inite-ai/inite-brain-service/issues/182)) ([e55296a](https://github.com/inite-ai/inite-brain-service/commit/e55296adfaceb8e250c84157f24d69b8c95a4643))
* **ai:** local NER pipeline to a worker thread ([#191](https://github.com/inite-ai/inite-brain-service/issues/191)) ([09e7856](https://github.com/inite-ai/inite-brain-service/commit/09e7856da18939a4321933707de976eab7be78f2))
* **communities:** offload label propagation to the job worker pool ([#184](https://github.com/inite-ai/inite-brain-service/issues/184)) ([ee4967c](https://github.com/inite-ai/inite-brain-service/commit/ee4967c48f43509a70f59fb86cedd1b72214a5dd))
* **dreams,documents:** audit wave P3 — flag-gated pipeline fixes ([#178](https://github.com/inite-ai/inite-brain-service/issues/178)) ([e868254](https://github.com/inite-ai/inite-brain-service/commit/e868254df718871cf33839acd1b7c06de6dc30f7))
* **jobs:** bounded per-jobType poller concurrency with tenant and global caps ([#183](https://github.com/inite-ai/inite-brain-service/issues/183)) ([fc97d01](https://github.com/inite-ai/inite-brain-service/commit/fc97d019851a821672dad2d8a08ac79495774d69))
* **live:** audit wave P4 — nightly refit batching, bounded reads, gauge fixes ([#179](https://github.com/inite-ai/inite-brain-service/issues/179)) ([7509116](https://github.com/inite-ai/inite-brain-service/commit/7509116bd0f80085474c2a4fcfe2288707c7187f))
* **search:** offload tokenBudget counting to the worker pool with sync fallback ([#189](https://github.com/inite-ai/inite-brain-service/issues/189)) ([ccc6c59](https://github.com/inite-ai/inite-brain-service/commit/ccc6c59be1fc0443b065641caabe590608fd0c1c))

## [0.6.2](https://github.com/inite-ai/inite-brain-service/compare/v0.6.1...v0.6.2) (2026-07-11)


### Bug Fixes

* **documents:** audit wave F3 — async run-ledger reliability + external provenance ([#162](https://github.com/inite-ai/inite-brain-service/issues/162)) ([fc54552](https://github.com/inite-ai/inite-brain-service/commit/fc54552a31bab856d76925596bc3cde1e711a4f6))
* **func:** audit wave F1 — dead leases page, limit&gt;20 cap, MCP pack parity, doc drift ([#160](https://github.com/inite-ai/inite-brain-service/issues/160)) ([140647b](https://github.com/inite-ai/inite-brain-service/commit/140647b17d3db694e887fefb2c35fdd13bad2f23))
* **ingest:** audit wave F2 — detect_contradiction mirrors fn::resolve_fact (0055) ([#161](https://github.com/inite-ai/inite-brain-service/issues/161)) ([0c5c844](https://github.com/inite-ai/inite-brain-service/commit/0c5c8442daf7415c29a4d5ecc55a7fa875a02ebc))
* **observability:** audit wave F4 — corroborate backlog, rerank metric, config catalogue, docs ([#163](https://github.com/inite-ai/inite-brain-service/issues/163)) ([38cbdb7](https://github.com/inite-ai/inite-brain-service/commit/38cbdb7689cb36bc1c0ef6b55f3896bb00a5519f))

## [0.6.1](https://github.com/inite-ai/inite-brain-service/compare/v0.6.0...v0.6.1) (2026-07-11)


### Bug Fixes

* **hnsw:** refuse create on a stale-dimension index + document drop-first recovery ([#158](https://github.com/inite-ai/inite-brain-service/issues/158)) ([efaa6ea](https://github.com/inite-ai/inite-brain-service/commit/efaa6ea82e2890bf0d41fd99a3608b78a03ce37c))
* **security:** audit wave A — dead nightly cron + phantom-fence PII leaks + artifact scope ([#154](https://github.com/inite-ai/inite-brain-service/issues/154)) ([c32c4c8](https://github.com/inite-ai/inite-brain-service/commit/c32c4c825408715c5b15068719811d8d78f1dce4))
* **security:** audit wave B — feedback trust farming, source.meta bypass, entity scope collision ([#156](https://github.com/inite-ai/inite-brain-service/issues/156)) ([18fd8eb](https://github.com/inite-ai/inite-brain-service/commit/18fd8eb141a019d3f987fd0924254601de059f49))
* **security:** audit wave C — ABAC behind-flag hardening (meta-union, resolver, windows, candidates) ([#157](https://github.com/inite-ai/inite-brain-service/issues/157)) ([7153a61](https://github.com/inite-ai/inite-brain-service/commit/7153a61f10440c7d0ac89ab9e1ac06ec676b7ff2))
* **gdpr:** audit wave E — env-flag coverage, ABAC fence validation, edge audit purge ([#159](https://github.com/inite-ai/inite-brain-service/issues/159)) ([0ecddcf](https://github.com/inite-ai/inite-brain-service/commit/0ecddcf))

## [0.6.0](https://github.com/inite-ai/inite-brain-service/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* **abac-ui:** match previews, decision charts, live tail, graph lens (UI wave 2) ([#149](https://github.com/inite-ai/inite-brain-service/issues/149)) ([d561019](https://github.com/inite-ai/inite-brain-service/commit/d561019afaa5ec6f2c2da2d513d3b2818ec1a72f))
* **abac-ui:** policy editor + Key Lens + decisions feed (admin UI wave 1) ([#148](https://github.com/inite-ai/inite-brain-service/issues/148)) ([0659c7b](https://github.com/inite-ai/inite-brain-service/commit/0659c7b7eb216074fd2c0f3ce1b704d67a3a3821))
* **abac:** DB-fence groundwork + finding — SurrealDB PERMISSIONS inert for system users ([#151](https://github.com/inite-ai/inite-brain-service/issues/151)) ([69b7a95](https://github.com/inite-ai/inite-brain-service/commit/69b7a957b40545de33a3aa48cb22b3c070f09368))
* **abac:** metadata projection + simulation surface + tooling endpoints ([#152](https://github.com/inite-ai/inite-brain-service/issues/152)) ([fd1f71b](https://github.com/inite-ai/inite-brain-service/commit/fd1f71b58f73d607d42ac54daf2025b6a55c207a))
* **abac:** per-key policy sets — action gating + row-level read filtering ([#146](https://github.com/inite-ai/inite-brain-service/issues/146)) ([bae8ec4](https://github.com/inite-ai/inite-brain-service/commit/bae8ec460f38a6395d1001a7f82f85e45949a8cc))
* **abac:** temporal windows + meta backfill + corroboration meta-union ([#150](https://github.com/inite-ai/inite-brain-service/issues/150)) ([1400be0](https://github.com/inite-ai/inite-brain-service/commit/1400be0fc5e3290763720c7f2be5a13f3fff1ead))
* **memory:** quality waves 1–3 + per-user scope tier — hygiene fixes, usage/feedback loops, promotion, HNSW, user memory ([#145](https://github.com/inite-ai/inite-brain-service/issues/145)) ([86aa9c1](https://github.com/inite-ai/inite-brain-service/commit/86aa9c19656a9f5145384f6a76341df950588a90))
* **metrics:** feed the brain_policy_sets_active gauge from the nightly sweep ([#153](https://github.com/inite-ai/inite-brain-service/issues/153)) ([a814375](https://github.com/inite-ai/inite-brain-service/commit/a8143751af71f4408cf15422c6a7a4a2aede5a42))


### Bug Fixes

* source-reputation abuse, document-pipeline blockers, local reranker, cost caps ([#142](https://github.com/inite-ai/inite-brain-service/issues/142)) ([1bf6a62](https://github.com/inite-ai/inite-brain-service/commit/1bf6a62c53f4f664db530516246bc32d48f998ba))

## [0.5.0](https://github.com/inite-ai/inite-brain-service/compare/v0.4.0...v0.5.0) (2026-07-09)


### Features

* **documents:** Source → Indexer → Candidates → Brain document pipeline ([#140](https://github.com/inite-ai/inite-brain-service/issues/140)) ([4597261](https://github.com/inite-ai/inite-brain-service/commit/4597261e9263e69071a3b03d1c4ba8ce82aa4e12))

## [0.4.0](https://github.com/inite-ai/inite-brain-service/compare/v0.3.0...v0.4.0) (2026-07-09)


### Features

* **search:** local cross-encoder reranker fallback (no Cohere key) ([#6](https://github.com/inite-ai/inite-brain-service/issues/6)) ([#139](https://github.com/inite-ai/inite-brain-service/issues/139)) ([bc1bee8](https://github.com/inite-ai/inite-brain-service/commit/bc1bee8af1f83afa66ebcb0f34f38af49b711a2d))


### Bug Fixes

* **landing:** add x-default hreflang to the sitemap ([#135](https://github.com/inite-ai/inite-brain-service/issues/135)) ([d4c983e](https://github.com/inite-ai/inite-brain-service/commit/d4c983e0c62182860640bd80a08e88051a40e627))
* **landing:** full ESLint in CI, replacing removed `next lint` ([#3](https://github.com/inite-ai/inite-brain-service/issues/3)) ([#136](https://github.com/inite-ai/inite-brain-service/issues/136)) ([f656e45](https://github.com/inite-ai/inite-brain-service/commit/f656e45edecab6375f56fde1214097682c65d3b4))

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
