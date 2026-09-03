# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [2.2.0](https://github.com/inite-ai/inite-brain-service/compare/v2.1.0...v2.2.0) (2026-09-03)


### Features

* **beliefs:** belief-aware serving lane with belief citations ([#412](https://github.com/inite-ai/inite-brain-service/issues/412)) ([5b754c6](https://github.com/inite-ai/inite-brain-service/commit/5b754c65b8de8bdf1116ac9ba18ddeae2e25eece))
* **beliefs:** read API behind BELIEFS_API_ENABLED ([#406](https://github.com/inite-ai/inite-brain-service/issues/406)) ([dc99017](https://github.com/inite-ai/inite-brain-service/commit/dc99017d46653b6594049fde9a6a22cc40e827a9))
* **beliefs:** semantic belief substrate + scene promotion ([#405](https://github.com/inite-ai/inite-brain-service/issues/405)) ([d76a9d6](https://github.com/inite-ai/inite-brain-service/commit/d76a9d6b1fa827b70b8eeba7805ae21b30668012))
* **compaction:** per-tenant retention overrides + promotion corroboration floor + conflict guard ([#377](https://github.com/inite-ai/inite-brain-service/issues/377)) ([e62751a](https://github.com/inite-ai/inite-brain-service/commit/e62751a8f100aa6ece57fafde6d8935ffbf36b65))
* **consent:** media/biometric consent tier — read_media scope, pack modality consent, fail-closed media PII gate ([#380](https://github.com/inite-ai/inite-brain-service/issues/380)) ([09972b0](https://github.com/inite-ai/inite-brain-service/commit/09972b0c3a470abdfdf26e3ee42f4da47534357d))
* **deploy:** enable memory-fitness fix-wave flags in prod ([#420](https://github.com/inite-ai/inite-brain-service/issues/420)) ([3420d00](https://github.com/inite-ai/inite-brain-service/commit/3420d00291daf2f44a50ef1da2f313a8613f17f7))
* **deploy:** full production enablement wave — every default-off feature ON ([#414](https://github.com/inite-ai/inite-brain-service/issues/414)) ([7d79f3c](https://github.com/inite-ai/inite-brain-service/commit/7d79f3cda31d6f01df62c396f3ce3a8da423cc4f))
* **eval:** first-person memory fitness harness ([#411](https://github.com/inite-ai/inite-brain-service/issues/411)) ([eb6dfe5](https://github.com/inite-ai/inite-brain-service/commit/eb6dfe5a35d65c56f886670926bc149bbaa05a83))
* **evidence:** fragment retrieval lane + fragment citations ([#404](https://github.com/inite-ai/inite-brain-service/issues/404)) ([8bf86fd](https://github.com/inite-ai/inite-brain-service/commit/8bf86fd32f3e1022eddbe40a78a8148d7bad4bca))
* **evidence:** grounding status on claims — fail-closed capture, promotion + serving gates ([#388](https://github.com/inite-ai/inite-brain-service/issues/388)) ([c8d4e94](https://github.com/inite-ai/inite-brain-service/commit/c8d4e94dc23d81b94ca19b347d11d752dd000154))
* **evidence:** metadata-only evidence asset ingest ([#400](https://github.com/inite-ai/inite-brain-service/issues/400)) ([b6bea93](https://github.com/inite-ai/inite-brain-service/commit/b6bea9333bd2d7840cda4a0da0bee2c5dc028488))
* **evidence:** multimodal evidence substrate — assets, fragments, derived representations (0109) ([#382](https://github.com/inite-ai/inite-brain-service/issues/382)) ([7d346ac](https://github.com/inite-ai/inite-brain-service/commit/7d346ac43d171e887f80a8fda9b5919bee16f5a6))
* **evidence:** port multimodal contract + lifecycle hardening (evidence blob GC, strict pack validation) ([#392](https://github.com/inite-ai/inite-brain-service/issues/392)) ([dafa9da](https://github.com/inite-ai/inite-brain-service/commit/dafa9da09412323ddc3f5e53776ca85ae973e46c))
* **evidence:** processing lifecycle — broker, idempotent runs, quarantine seams ([#402](https://github.com/inite-ai/inite-brain-service/issues/402)) ([8758e12](https://github.com/inite-ai/inite-brain-service/commit/8758e12cf70a0337e4159a7569d3277b077e2507))
* **evidence:** single raw-read gateway — gate ladder, signed URLs, access audit ([#408](https://github.com/inite-ai/inite-brain-service/issues/408)) ([def7ee8](https://github.com/inite-ai/inite-brain-service/commit/def7ee8ee5fea53888baf817271f1cd0b291e0d2))
* **evidence:** split immutable assets from ownership grants (0122) ([#401](https://github.com/inite-ai/inite-brain-service/issues/401)) ([4a412c2](https://github.com/inite-ai/inite-brain-service/commit/4a412c2e3bcba2ebe91db981bb5593932e9ceac2))
* **fovea:** confidence-gated L3 escalation depth (adaptive, static fallback, default-off) ([#331](https://github.com/inite-ai/inite-brain-service/issues/331)) ([3d2384f](https://github.com/inite-ai/inite-brain-service/commit/3d2384fbc9bc5bbd54037843710d193754ce4191))
* **fovea:** evidence-capability verdict gate + outcome telemetry modality dimensions (0113) ([#383](https://github.com/inite-ai/inite-brain-service/issues/383)) ([dd7f243](https://github.com/inite-ai/inite-brain-service/commit/dd7f2432461960449a4dcce4a2c390030f53db5e))
* **fovea:** focus-signal capture + per-class calibration foundation (serving-neutral, default-off) ([#329](https://github.com/inite-ai/inite-brain-service/issues/329)) ([558a155](https://github.com/inite-ai/inite-brain-service/commit/558a155ab5673b42184e215bd84b1c57cad7a1ed))
* **fovea:** L3 anchor independence — direct/segment/temporal aux anchor sources when fact anchors are empty ([#373](https://github.com/inite-ai/inite-brain-service/issues/373)) ([8a3771d](https://github.com/inite-ai/inite-brain-service/commit/8a3771d013d81b774f91de5d715467c11943bdc0))
* **fovea:** L3 evidence citations — episode-level references for transcript-grounded claims ([#376](https://github.com/inite-ai/inite-brain-service/issues/376)) ([115422e](https://github.com/inite-ai/inite-brain-service/commit/115422ea3caafdbccbe8f5737e27321cbc31b7bd))
* **fovea:** lens-suppression governor — subtractive per-class lane suppression (adaptive, static fallback, default-off) ([#334](https://github.com/inite-ai/inite-brain-service/issues/334)) ([#334](https://github.com/inite-ai/inite-brain-service/issues/334)) ([5ef09de](https://github.com/inite-ai/inite-brain-service/commit/5ef09de2c0561c158c8729beb25cd4e049a3986b))
* **fovea:** pack attention hints as ordering-only anchor boost ([#399](https://github.com/inite-ai/inite-brain-service/issues/399)) ([88d05b5](https://github.com/inite-ai/inite-brain-service/commit/88d05b5381acca8941a70ec3ac1c156b436f87b0))
* **fovea:** per-class calibrated abstention threshold (adaptive, static fallback, default-off) ([#332](https://github.com/inite-ai/inite-brain-service/issues/332)) ([49c50d9](https://github.com/inite-ai/inite-brain-service/commit/49c50d9616e955486ba14a1c71f830b440124906))
* **fovea:** verifier answer-integrity arm — post-grounding plausibility gate + require-citations guard (both default-off) ([#337](https://github.com/inite-ai/inite-brain-service/issues/337)) ([a03f309](https://github.com/inite-ai/inite-brain-service/commit/a03f3095d9357ae07fe92fcfe0c00e2697f0b5ac))
* **fovea:** verifier-controlled fragment zoom — one bounded re-verify step ([#410](https://github.com/inite-ai/inite-brain-service/issues/410)) ([965b009](https://github.com/inite-ai/inite-brain-service/commit/965b009238c6bdbae0f2a6a63e80a4d7032dc17e))
* **mcp:** fact read tools, tool-observation ref on ingest_document, full-capability connector shim ([#393](https://github.com/inite-ai/inite-brain-service/issues/393)) ([5d8a0ad](https://github.com/inite-ai/inite-brain-service/commit/5d8a0aded84d7c2363a7fd49c07cf382cb78bc8a))
* **mcp:** tool observations — content-free evidence anchors for tool results (0111) ([#385](https://github.com/inite-ai/inite-brain-service/issues/385)) ([c9c4f39](https://github.com/inite-ai/inite-brain-service/commit/c9c4f3961ed4c697d5940ca641ae7267fbc38b5c))
* **mri:** measurement layer — MRI report + economics Pareto reporter (read-only, honest pending-eval) ([#338](https://github.com/inite-ai/inite-brain-service/issues/338)) ([831e6c1](https://github.com/inite-ai/inite-brain-service/commit/831e6c1d4520bcc4cdc9aa37e613dbaf368b541a))
* **multilingual:** confidence-aware language attribution + soft same-language boost (Tier 1, default-off) ([#351](https://github.com/inite-ai/inite-brain-service/issues/351)) ([f25f8d3](https://github.com/inite-ai/inite-brain-service/commit/f25f8d34f120ad489b594428b40413423c148003))
* **multilingual:** embeddingSpaceId + zero-downtime space migration protocol (Tier 2, default-off) ([#352](https://github.com/inite-ai/inite-brain-service/issues/352)) ([da3533a](https://github.com/inite-ai/inite-brain-service/commit/da3533a1460c2da8ba77646773a848a623eead6e))
* **multilingual:** hierarchical per-language calibration + answer-language guard (Tier 5, default-off) ([#356](https://github.com/inite-ai/inite-brain-service/issues/356)) ([89e52bb](https://github.com/inite-ai/inite-brain-service/commit/89e52bb227b6373368417f5844454c682afad016))
* **multilingual:** language-agnostic lane classifier + locale-time decomposition + typed conflict detection (Tier 4, default-off) ([#355](https://github.com/inite-ai/inite-brain-service/issues/355)) ([c192467](https://github.com/inite-ai/inite-brain-service/commit/c19246763503d47937c873ab5e45bdbea1b9d246))
* **multilingual:** reversible entity resolution + identifier policy + CJK segmentation (Tier 3, default-off) ([#353](https://github.com/inite-ai/inite-brain-service/issues/353)) ([2f397cb](https://github.com/inite-ai/inite-brain-service/commit/2f397cbe09172983b4e0aba31393e508da029a83))
* **outcomes:** transactional idempotent writes + decision-context telemetry (0119) ([#391](https://github.com/inite-ai/inite-brain-service/issues/391)) ([f1709d3](https://github.com/inite-ai/inite-brain-service/commit/f1709d346a804bed854225bed7c1d205a46cceb8))
* **packs:** memoryModel manifest section — domain perception contract ([#381](https://github.com/inite-ai/inite-brain-service/issues/381)) ([b29eaec](https://github.com/inite-ai/inite-brain-service/commit/b29eaec066a6b007a6d3fad83f43aeeb87f95a2a))
* **packs:** scene and state-delta candidate projections (default-deny redaction) ([#403](https://github.com/inite-ai/inite-brain-service/issues/403)) ([983e40c](https://github.com/inite-ai/inite-brain-service/commit/983e40c212b0a043f1348bda928207691c069f5c))
* **provenance:** PROVENANCE_EPISODE_NEIGHBOURS — sibling-turn widening of the one-hop provenance read (default off) ([#416](https://github.com/inite-ai/inite-brain-service/issues/416)) ([acf0a1e](https://github.com/inite-ai/inite-brain-service/commit/acf0a1e4a93987edf623e4d03680a7b38152e657))
* **provenance:** summary episode stamping + bounded recursive support-closure (Evidence plane) ([#371](https://github.com/inite-ai/inite-brain-service/issues/371)) ([1f60207](https://github.com/inite-ai/inite-brain-service/commit/1f602073e9de86325453423daab55293b59f4a3a))
* **provenance:** typed support graph — memory_support edges + closure walk ([#389](https://github.com/inite-ai/inite-brain-service/issues/389)) ([af28fd9](https://github.com/inite-ai/inite-brain-service/commit/af28fd96a8e8341750eaf1d50fa61cc811854a8b))
* **scenes:** evidence links — reconstructed_from edges to fragments and assets ([#407](https://github.com/inite-ai/inite-brain-service/issues/407)) ([2a87276](https://github.com/inite-ai/inite-brain-service/commit/2a8727602bd837c2d8031e62a959c288f45bc6c5))
* **scenes:** fingerprinted reconstruction versions + immutable enrichment ([#386](https://github.com/inite-ai/inite-brain-service/issues/386)) ([138c391](https://github.com/inite-ai/inite-brain-service/commit/138c3914c800b8d9eca3c07141fe6687eb684755))
* **scenes:** LLM enrichment + fact backlink + version purge (Brain v2 PR2) ([#374](https://github.com/inite-ai/inite-brain-service/issues/374)) ([4e7ca32](https://github.com/inite-ai/inite-brain-service/commit/4e7ca32aeddeedaeb0e2308de554720b62184f8a))
* **scenes:** memory_episode shadow substrate — versioned scene segmentation over raw episodes (0106) ([#370](https://github.com/inite-ai/inite-brain-service/issues/370)) ([25806dd](https://github.com/inite-ai/inite-brain-service/commit/25806ddb81aa6b552f8e586f20d36c46fe2b2caf))
* **search:** verified-use ranking/decay signals + tenant-aware decay resolution ([#378](https://github.com/inite-ai/inite-brain-service/issues/378)) ([92f123f](https://github.com/inite-ai/inite-brain-service/commit/92f123f73abb7ed03a3e843f92522c052c4d37ea))
* **strategy:** tool-trajectory experience memory (bet [#3](https://github.com/inite-ai/inite-brain-service/issues/3), default-off) ([#340](https://github.com/inite-ai/inite-brain-service/issues/340)) ([f0476c8](https://github.com/inite-ai/inite-brain-service/commit/f0476c841d24abf187a6a21551625326defc264a))
* **telemetry:** append-only memory outcome events + write-path rollup (0107) ([#372](https://github.com/inite-ai/inite-brain-service/issues/372)) ([2261fcb](https://github.com/inite-ai/inite-brain-service/commit/2261fcb44a88b0422305dad50e79012a622f5b38))
* **tenancy:** production tenant_registry backing knownCompanyIds (fan-out + platform-scope no longer empty in prod-JWKS) (R4) ([#367](https://github.com/inite-ai/inite-brain-service/issues/367)) ([2acec05](https://github.com/inite-ai/inite-brain-service/commit/2acec05ca16a82c303096fcd3181f0764e776e8d))


### Bug Fixes

* **answer-cache:** additive-write freshness probe + hardening (scope-before-cap, new-entity TTL, language-agnostic enum) — audit F1 + R2 ([#339](https://github.com/inite-ai/inite-brain-service/issues/339)) ([15c21a1](https://github.com/inite-ai/inite-brain-service/commit/15c21a1e2c9c5f001b7a403ad5bc5591a2b1d00e))
* **audit:** atomic changefeed drain + deterministic event id + changefeedRow() in all consumers (R4) ([#366](https://github.com/inite-ai/inite-brain-service/issues/366)) ([55b9be0](https://github.com/inite-ai/inite-brain-service/commit/55b9be0325b302872d0ba201c02982dca695523c))
* **auth:** deny cross-tenant admin ops without platform scope + gate (P0) ([#348](https://github.com/inite-ai/inite-brain-service/issues/348)) ([527720c](https://github.com/inite-ai/inite-brain-service/commit/527720c972312264dcb3aa2a5c9cd85f45b8a135))
* **beliefs:** belief-lane prompt variant must preserve abstention discipline ([#413](https://github.com/inite-ai/inite-brain-service/issues/413)) ([ae30a30](https://github.com/inite-ai/inite-brain-service/commit/ae30a30f2ba7ba529c248daa8136e233961fdfe1))
* **beliefs:** disambiguate the belief-lane date token from event-date stamps (BELIEFS_LANE_DATE_DISAMBIGUATION) ([#415](https://github.com/inite-ai/inite-brain-service/issues/415)) ([732efbc](https://github.com/inite-ai/inite-brain-service/commit/732efbcd492bc07177a4398f3e0edab9fbb39f8a))
* **brain-landing:** fail-closed end-user BFF exchange + pin userId to session ([#342](https://github.com/inite-ai/inite-brain-service/issues/342)) ([3cec8d9](https://github.com/inite-ai/inite-brain-service/commit/3cec8d910725dfe7db3986e0752902d42b8acbac))
* **ci:** keep ONNX models out of the in-process e2e worker ([#379](https://github.com/inite-ai/inite-brain-service/issues/379)) ([7882547](https://github.com/inite-ai/inite-brain-service/commit/788254756a33ec10063f0f76531c806df4337efa))
* **ci:** unblock build-test — 30-min timeout + modality-only memoryModel acceptance ([#390](https://github.com/inite-ai/inite-brain-service/issues/390)) ([8fdf449](https://github.com/inite-ai/inite-brain-service/commit/8fdf449fc72f4d2a83d11ea470077eb230d1611a))
* **db:** 0093 scope backfill dies on 3.2.4 planner leaking NONE rows through indexed WHERE ([#422](https://github.com/inite-ai/inite-brain-service/issues/422)) ([1ca859a](https://github.com/inite-ai/inite-brain-service/commit/1ca859a1b74147d1ce7b5038f40ba124c64c130a))
* **db:** harden DELETE-WHERE statements against the SurrealDB 3.2.4 compound-index planner no-op ([#375](https://github.com/inite-ai/inite-brain-service/issues/375)) ([57f4c86](https://github.com/inite-ai/inite-brain-service/commit/57f4c867ea83e705a79cd21373d3b46ead696cd3))
* **db:** re-attach audit CHANGEFEED for 3.x-first tenants via DEFINE TABLE OVERWRITE (0105) ([#368](https://github.com/inite-ai/inite-brain-service/issues/368)) ([3268785](https://github.com/inite-ai/inite-brain-service/commit/32687859521ef47491eb96f6bfc75e4b74d84abb))
* **deploy:** AUTH_SERVICE_ISSUER must match the auth-service's real iss (auth-api host) ([#421](https://github.com/inite-ai/inite-brain-service/issues/421)) ([d37a762](https://github.com/inite-ai/inite-brain-service/commit/d37a7625348aafc0d34a46d2bb4ee6477450b19b))
* **deploy:** move enablement flags to env_file — run script blew the 21k expression limit ([#418](https://github.com/inite-ai/inite-brain-service/issues/418)) ([ccbc573](https://github.com/inite-ai/inite-brain-service/commit/ccbc573f2981ce8967c10f9fe7d585299e8a7075))
* **eval:** memory-fitness runner must pass userId to timeline/competing reads ([#419](https://github.com/inite-ai/inite-brain-service/issues/419)) ([72dc4d4](https://github.com/inite-ai/inite-brain-service/commit/72dc4d4c8f9ad0bb176e4795c193597a056d2650))
* **facts:** per-user scope on timeline/competing reads + direct-fact conflict formation ([#417](https://github.com/inite-ai/inite-brain-service/issues/417)) ([1f99d16](https://github.com/inite-ai/inite-brain-service/commit/1f99d16682642a53da8b6fd70d88b05e95bc5455))
* **fovea:** route L3 through the answer-integrity gate ([#341](https://github.com/inite-ai/inite-brain-service/issues/341)) ([b45bd08](https://github.com/inite-ai/inite-brain-service/commit/b45bd08294bfeb39f51ac4db347a998d896c7f84))
* **gdpr:** atomic entity erase via client transaction + idempotent requestId; correct the non-firing DB-fence claim (R4) ([#357](https://github.com/inite-ai/inite-brain-service/issues/357)) ([0dfaf78](https://github.com/inite-ai/inite-brain-service/commit/0dfaf784617b031b9c72f33905b56e5b89c1cd72))
* **gdpr:** cascade forget through source documents, chunks, candidates and indexer runs ([#384](https://github.com/inite-ai/inite-brain-service/issues/384)) ([bed07d7](https://github.com/inite-ai/inite-brain-service/commit/bed07d784c63227d6a80903b960c9becf47bf398))
* **hardening:** stable BFF error code, N/A community count, documented e2e forceExit (R3 P2) ([#345](https://github.com/inite-ai/inite-brain-service/issues/345)) ([345c1ab](https://github.com/inite-ai/inite-brain-service/commit/345c1ab58f84c27a4e7099345c95acb75442ee4a))
* **mcp:** gate MCP resources with the same ABAC/grant + error sanitization as tools ([#336](https://github.com/inite-ai/inite-brain-service/issues/336)) ([0d6a82b](https://github.com/inite-ai/inite-brain-service/commit/0d6a82b1b88da55cf26c71179410e74b360732a2))
* **mri:** honest cells — fail-closed recorder, windowed counters, evidence-gated premise, cache-hit accounting (R3 P1) ([#346](https://github.com/inite-ai/inite-brain-service/issues/346)) ([2b79399](https://github.com/inite-ai/inite-brain-service/commit/2b793999480669e4472a771f9f135f0bbd1e5659))
* **mri:** honest cells — terminal-outcome proxy, upper-bound cost, pending latency, fail-closed recorder, exposed premise ([#343](https://github.com/inite-ai/inite-brain-service/issues/343)) ([88bb3cd](https://github.com/inite-ai/inite-brain-service/commit/88bb3cd1c954eaaa9fd53eb3662c90692dad9005))
* **privacy:** mixed-user derived rows carry userIds and fail closed behind a fence ([#387](https://github.com/inite-ai/inite-brain-service/issues/387)) ([744dca4](https://github.com/inite-ai/inite-brain-service/commit/744dca4be173646d2145d38ef79cc4c82616aa95))
* **stats:** user-scope overview counts for userId-pinned callers (F3) ([#335](https://github.com/inite-ai/inite-brain-service/issues/335)) ([63de4f8](https://github.com/inite-ai/inite-brain-service/commit/63de4f865f8d85de73309cec7f15aee9a1a3ffc3))
* **strategy:** active strategies immutable to trajectory capture — candidate revision + unverified evidence ref (R3 P1) ([#349](https://github.com/inite-ai/inite-brain-service/issues/349)) ([b5af977](https://github.com/inite-ai/inite-brain-service/commit/b5af9771737a72395755532e4cc790a912013259))

## [2.1.0](https://github.com/inite-ai/inite-brain-service/compare/v2.0.0...v2.1.0) (2026-08-23)


### Features

* **auth:** hierarchical scope-tag foundation — scope column + parity-proven visibility evaluator (default-off) ([#316](https://github.com/inite-ai/inite-brain-service/issues/316)) ([8e2af77](https://github.com/inite-ai/inite-brain-service/commit/8e2af77a77783b92cf3e641180f29bf4032ebfc4))
* **db:** computed views for tenant counters behind STATS_VIEWS_ENABLED ([95cf3bb](https://github.com/inite-ai/inite-brain-service/commit/95cf3bbdd23546194b96a83c5e1cdcf1b80b1bfa))
* **db:** validate stack on SurrealDB 3.2.4, bump CI/dev pins, add prod cutover runbook ([d5ee2a1](https://github.com/inite-ai/inite-brain-service/commit/d5ee2a16a0760cc9aec42e07cbbc768bbd21f945))
* **db:** write-time derived-staleness event (0089) — closes the 0072 nightly-drain hole ([9a8bcdf](https://github.com/inite-ai/inite-brain-service/commit/9a8bcdf775ecb5fcd5869159d455ccb1565fc53a))
* **provenance:** char-span grounding quotes — deriver emit + mechanical anchoring + provenance API spans ([#310](https://github.com/inite-ai/inite-brain-service/issues/310)) ([4125f7b](https://github.com/inite-ai/inite-brain-service/commit/4125f7b8381d881f0dba373af643adb0b8fabd27))
* **search:** trace-derived usage ranking factor — readCount as a bounded, default-off ranking signal ([#314](https://github.com/inite-ai/inite-brain-service/issues/314)) ([ee14fe6](https://github.com/inite-ai/inite-brain-service/commit/ee14fe6e50334c1c4b1c1e80d2a433784ebaee56))
* **security:** memory-injection red-team suite + opt-in ingest unicode sanitization ([#312](https://github.com/inite-ai/inite-brain-service/issues/312)) ([4a05c5c](https://github.com/inite-ai/inite-brain-service/commit/4a05c5c74ef2646ab900b75722558079ec828979))
* **staleness:** 0089 fact_staleness event — write-time derived-fact marking ([f1b8cab](https://github.com/inite-ai/inite-brain-service/commit/f1b8cab48b4cf9ecac06583aea00b70e22c1a4f7))
* **stats:** 0088 computed count() views for tenant counters behind STATS_VIEWS_ENABLED ([3bc1187](https://github.com/inite-ai/inite-brain-service/commit/3bc1187a7b5d8383320e515641a9fd3a82842f35))
* **strategy:** ReasoningBank-shape strategy-memory lane — separate store, k=1 advisory retrieval, distill + lifecycle cron ([#313](https://github.com/inite-ai/inite-brain-service/issues/313)) ([7a83ba4](https://github.com/inite-ai/inite-brain-service/commit/7a83ba4aab82ad062bdcae3ec2ceb9902b786f9b))
* **synthesize:** fact-lifecycle-gated answer cache — exact-match serving with check-on-read invalidation ([#311](https://github.com/inite-ai/inite-brain-service/issues/311)) ([51ebb53](https://github.com/inite-ai/inite-brain-service/commit/51ebb5357bafd25313d570d2a155bcfcedef682c))
* **synthesize:** L3 confidence-gated escalation — full-session raw-context generation on verifier failure ([#315](https://github.com/inite-ai/inite-brain-service/issues/315)) ([f12f2b2](https://github.com/inite-ai/inite-brain-service/commit/f12f2b282a4e638035fd820210fffd11bc7abe2f))

## [2.0.0](https://github.com/inite-ai/inite-brain-service/compare/v1.1.0...v2.0.0) (2026-08-22)


### ⚠ BREAKING CHANGES

* **deriver:** atomic derive — staging namespace, per-(tenant,version) lease, DELETE-then-UPDATE flip (audit 2026-08-19 P1)

### Features

* **deriver,synthesize:** DERIVER_DATE_RESOLVE + RETRIEVAL_ENUM_STRICT (default-off) ([211db52](https://github.com/inite-ai/inite-brain-service/commit/211db528aaf36f687c58db87d3f6d2c30637010e))
* **deriver:** DERIVER_ASPECT_ROLLUPS — mechanical per-(entity, aspect) list-facts (default-off) ([0640e21](https://github.com/inite-ai/inite-brain-service/commit/0640e21663bf5a7c9bb4c662dae19db50c3e1cc3))
* **deriver:** DERIVER_DATE_AUDIT post-pass + reasoning-model call params (default-off) ([0266294](https://github.com/inite-ai/inite-brain-service/commit/02662945a4721c045610adabe9eb383136cd5f6d))
* **deriver:** DERIVER_DATE_RESOLVE — V12 §3 occurred_on anti-collapse rules (default-off) ([b91c147](https://github.com/inite-ai/inite-brain-service/commit/b91c1471fb6395a06462fbb28af23a075c466178))
* **deriver:** V13 write-side legs — date audit, aspect rollups, reasoning-model deriver (default-off) ([d64e135](https://github.com/inite-ai/inite-brain-service/commit/d64e135441bddfab88cbc804e98ab4393f87a837))
* **digest:** per-user policy metadata on conversation_digest (V11 item 10) ([64439ab](https://github.com/inite-ai/inite-brain-service/commit/64439ab66fcfbea37cc5095cee87454bf18d78b3))
* **facts:** fact read + provenance API behind FACTS_API_ENABLED ([db65006](https://github.com/inite-ai/inite-brain-service/commit/db65006c405239d8ad501de413491616c980582c))
* **facts:** fact read + provenance API behind FACTS_API_ENABLED ([c4f46fd](https://github.com/inite-ai/inite-brain-service/commit/c4f46fdf817c660f718d96e61aa8db5b0795ec1e))
* **multiworld:** assistant lane v1.1 — exchange granularity (SeCom retrieval unit) ([74ce256](https://github.com/inite-ai/inite-brain-service/commit/74ce2568b8c4bb1f9b96a7b8f661e02dea6897b9))
* **multiworld:** typed projections over one substrate — multi-pin read, typed derive, assistant lane, facts-as-keys (all default-off) ([8b22c73](https://github.com/inite-ai/inite-brain-service/commit/8b22c73862940a9f661be4f2fefe0042b28f607f))
* **multiworld:** typed projections over one substrate (multi-pin read, typed derive, assistant lane, facts-as-keys) ([92ec440](https://github.com/inite-ai/inite-brain-service/commit/92ec440dcddc227a93487055dcad19f9895739d5))
* **retrieval:** genre preset layer — measured defaults per RETRIEVAL_GENRE ([84e60ae](https://github.com/inite-ai/inite-brain-service/commit/84e60ae1cba8c109d353e5214070443d552f6c57))
* **search,synthesize:** fact-level cross-encoder rerank + mention-date fact lines (default-off) ([e0208b0](https://github.com/inite-ai/inite-brain-service/commit/e0208b086d190ffc9c291aecfbf71fe57f407622))
* **search,synthesize:** fact-level cross-encoder rerank + mention-date fact lines (default-off) ([d52cec2](https://github.com/inite-ai/inite-brain-service/commit/d52cec2125b4408c40eefa6e0ad195be158c3e12))
* **search:** genre preset layer for RetrievalProfile ([4c35b32](https://github.com/inite-ai/inite-brain-service/commit/4c35b32961085f7ed09f8e192c3b1d2475bd0616))
* **synthesize:** RETRIEVAL_ENUM_STRICT — §8 item 3 enumeration scope discipline (default-off); runner --guardrails override ([b11abc4](https://github.com/inite-ai/inite-brain-service/commit/b11abc4cbb5eba7d6eb081832a9ca86015911333))
* **users:** rolling user profile API behind USER_PROFILE_API_ENABLED ([dcf5843](https://github.com/inite-ai/inite-brain-service/commit/dcf58433b90a9ef0ef5cbb405a4390abb50b203b))
* **users:** rolling user profile API v1 (deterministic, no LLM calls) ([c9c94bf](https://github.com/inite-ai/inite-brain-service/commit/c9c94bf601229a55c9fb085351088b51955bd4f1))
* **v13:** ten default-off levers from the memory research pass — raw-window, event-time grounding, compose pass, scene traces, search loop, and answer-side frames ([ec8f8ff](https://github.com/inite-ai/inite-brain-service/commit/ec8f8ff7cc0730dfa06573738241298ecdd23de1))
* **v13:** ten default-off memory levers from the research pass ([393cadb](https://github.com/inite-ai/inite-brain-service/commit/393cadb5946e8771cfa29a6c4f2e5322ff7d38fc))


### Bug Fixes

* **audit-2026-08-19:** secondary-search filter inheritance, ABAC projections, scoped-pool re-auth, digest lifecycle, V13 edge cases ([208ac72](https://github.com/inite-ai/inite-brain-service/commit/208ac7278b11ad3b7fae476878a037845f6c5e6b))
* **audit-2026-08-21 P0:** mention ingest carries per-user scope end to end ([40708d3](https://github.com/inite-ai/inite-brain-service/commit/40708d3de95249932467c5d3891ee6eb035bb356))
* **audit-2026-08-21:** read-set lifecycle guard, scoped fail-closed, secondary DTO axes, lane budget + v1 revert, jest worktree scan ([f2625f8](https://github.com/inite-ai/inite-brain-service/commit/f2625f8f93d260706ab1158524cdb4d84eeec99f))
* **audit:** per-user digest policy metadata, 0085 lifecycle suite, hermetic unit split ([e8224b6](https://github.com/inite-ai/inite-brain-service/commit/e8224b600b420fa9a91755e27e12006161961618))
* **contracts:** close the wire-contract tails — full retrieval-profile read-back, facts + user-profile in OpenAPI ([d23604d](https://github.com/inite-ai/inite-brain-service/commit/d23604dfe1f16a4849a1a866301da8823cbc979d))
* **contracts:** full retrieval-profile read-back + facts/user-profile OpenAPI coverage ([9710942](https://github.com/inite-ai/inite-brain-service/commit/9710942671e18289c8f3ccc378276154c3f3402e))
* **deriver,search:** fail-closed grounding scope, per-run staging fencing, trust band default off ([5f6a9c3](https://github.com/inite-ai/inite-brain-service/commit/5f6a9c3a8f226bec517d99b1cea30cee1fbe99ea))
* **deriver,search:** fail-closed grounding scope, per-run staging fencing, trust band default off ([53e4d48](https://github.com/inite-ai/inite-brain-service/commit/53e4d486bfd838e0d0cc0c69bf8eaba0ebd9f46c))
* **deriver,synthesize:** apply the /code-review 284 findings before the armK/armL runs ([d0b27b5](https://github.com/inite-ai/inite-brain-service/commit/d0b27b5864641f54572c8654f9635a740a1b320c))
* **deriver,users:** audit importants — lease fencing, single-transaction flip, strict profile scope ([f1ea1df](https://github.com/inite-ai/inite-brain-service/commit/f1ea1df72ee654c48e611458d15ca78c1a932351))
* **deriver,users:** lease fencing, single-transaction flip, strict profile scope ([fb93ea8](https://github.com/inite-ai/inite-brain-service/commit/fb93ea8200d66d45a462fdd69e009b22934c2632))
* **deriver:** atomic derive — staging namespace, per-(tenant,version) lease, DELETE-then-UPDATE flip (audit 2026-08-19 P1) ([63b5bc9](https://github.com/inite-ai/inite-brain-service/commit/63b5bc963cf987c0654fa36430dc113717626673))
* **deriver:** rollup group key separator — a stray NUL byte stood in for the delimiter ([999a38d](https://github.com/inite-ai/inite-brain-service/commit/999a38d58ecc0cfdd3f7e979b04cf68a1615ed0b))
* **deriver:** staging namespace + leader lease + transactional flip for atomic world builds (audit P1) ([04bfc0f](https://github.com/inite-ai/inite-brain-service/commit/04bfc0fec21334a095b9e15bd1b2fe99c6577796))
* **landing:** the footer links that pointed nowhere ([2f8ae2d](https://github.com/inite-ai/inite-brain-service/commit/2f8ae2d52ab244cd4253e4adef074a0644441631))
* **landing:** the footer links that pointed nowhere ([935995b](https://github.com/inite-ai/inite-brain-service/commit/935995badce6764ab69d7d92a792058a59359308))
* **landing:** the product declared its parent company instead of itself ([90671a9](https://github.com/inite-ai/inite-brain-service/commit/90671a9818f9c5ca455c3856b85dd2cc434e0144))
* **security,search:** release blockers — derive user scope, retract ownership, rerank trust band ([ae869f6](https://github.com/inite-ai/inite-brain-service/commit/ae869f64bfc10e3bf99c83b4a6f25443f62b0ff6))
* **security,search:** three release blockers — derive user scope, retract ownership fence, rerank trust band ([e01f0af](https://github.com/inite-ai/inite-brain-service/commit/e01f0afbc3155c0d23c3a368de3e5f0384f3ef7f))
* **synthesize:** reasoning-model call params for the generator — SYNTHESIZE_MODEL=gpt-5-* no longer reads as 100% generator_error ([fdc1124](https://github.com/inite-ai/inite-brain-service/commit/fdc1124184d3da7b48bd9728125dda86dd55512f))

## [1.1.0](https://github.com/inite-ai/inite-brain-service/compare/v1.0.0...v1.1.0) (2026-08-15)


### Features

* **eval:** false-premise scenarios + hallucination-resistance metric ([a634e4d](https://github.com/inite-ai/inite-brain-service/commit/a634e4d3313e8c8bb7e7b5024677f83030784bce))


### Bug Fixes

* **deps:** dedupe yaml@2.9.0 lockfile blocks left by textual dependabot merges ([64d9172](https://github.com/inite-ai/inite-brain-service/commit/64d9172ab318583ee5bc9ff08c310b8ca3ed08ea))
* **deps:** dedupe yaml@2.9.0 lockfile blocks left by textual dependabot merges ([fe7b1c1](https://github.com/inite-ai/inite-brain-service/commit/fe7b1c1379b8fd686c3673b4e5773e004db31d17))
* **search:** edge-expansion default OFF after measured-null ablation + alpha-0 parser fix ([3f3cb56](https://github.com/inite-ai/inite-brain-service/commit/3f3cb56dacacc96deeddbc3062758e84a43547e6))
* **search:** edge-expansion default OFF after the measured-null ablation + alpha-0 parser fix ([3a0ec1c](https://github.com/inite-ai/inite-brain-service/commit/3a0ec1c08e2aee9fc54f3bdafc3dfda20000763f))

## [1.0.0](https://github.com/inite-ai/inite-brain-service/compare/v0.8.1...v1.0.0) (2026-08-15)


### ⚠ BREAKING CHANGES

* **extraction:** S4 — one extraction pipeline profile + one write primitive
* **engine:** S3 — RetrievalProfile object + first-class Lane registry
* **engine:** S2 — fold the default-on winners into the single path
* **engine:** S1 — delete measurement-killed forks, code paths included

### Features

* **admin:** aspect aggregate composer over per-entity facts (Lane C) ([88b08ad](https://github.com/inite-ai/inite-brain-service/commit/88b08adafd0d60a8f25aaf75cebc7f8dd3311722))
* **admin:** DERIVER_DIGEST — rolling conversation digest, write side (V12 §2, graphiti saga port) ([cc3c6d3](https://github.com/inite-ai/inite-brain-service/commit/cc3c6d37ec50ef1baf4da26037682ac830850832))
* **admin:** DERIVER_MENTION_STAMP — per-fact mention anchor (V12 §1, graphiti reference_time port) ([2c615c9](https://github.com/inite-ai/inite-brain-service/commit/2c615c98a9e262c2b0f81161a6b820ad12dd2e17))
* **admin:** topic-arc composer — summary_arc_* observations (V9 §3) ([93b7ea2](https://github.com/inite-ai/inite-brain-service/commit/93b7ea24379a74d3d7b72710da1f80101b45e69b))
* **admin:** version-aware aspect aggregates for pinned derived worlds (R4) ([328acfc](https://github.com/inite-ai/inite-brain-service/commit/328acfc2792255a1e1ac88c43a792b07e1d41d1c))
* **agent-qa:** agent-in-loop QA — ReAct loop over memory search (/v1/answer) ([fafc96e](https://github.com/inite-ai/inite-brain-service/commit/fafc96eed84f5786c588cb643d1a0a96df31ad97))
* **agent-qa:** escalation routing — one-shot first, loop only on weak answers (R3b) ([da076de](https://github.com/inite-ai/inite-brain-service/commit/da076de0703adf0b26132b0e2ba42ff2c58f79d1))
* **agent-qa:** sharper answer contract — aggregation, single-hop directness ([d5bfb10](https://github.com/inite-ai/inite-brain-service/commit/d5bfb10f4c7ebecd7fe5b347c621ff6653b53ac3))
* **agent-qa:** V2 tool set — masked search, timeline enumerator, transcript grep (R3) ([f7b531d](https://github.com/inite-ai/inite-brain-service/commit/f7b531d162105d094b360d8b43c08f20acc0b70d))
* **derive:** completion pass + truncation guard (deriver recall) ([21a1696](https://github.com/inite-ai/inite-brain-service/commit/21a1696471bdad4d0283e1da16d95e623f60861f))
* **derive:** derived-world lifecycle (DERIVER_SLOT_SEMANTICS) + resolver NONE-fence ([134b455](https://github.com/inite-ai/inite-brain-service/commit/134b455a7ea00a49a6589d9e9654b276de0517d5))
* **deriver:** E3a assistant-content propositions (DERIVER_ASSISTANT_CONTENT) ([90976be](https://github.com/inite-ai/inite-brain-service/commit/90976be78da4abe72444661717b97ff020d4b318))
* **derive:** volume-neutral salience grading turn (DERIVER_SALIENCE_STAMP v2) ([c3547f6](https://github.com/inite-ai/inite-brain-service/commit/c3547f652ddc1db7bda3e68dab768f70ec045b34))
* **driver:** surface 3 — projection registry + public rebuild verb (PROJECTIONS_API_ENABLED) ([d919f71](https://github.com/inite-ai/inite-brain-service/commit/d919f71954f3ac0018994e1d2479c70ed3885984))
* **driver:** surface 4 — new-episode webhook push (EPISODE_SUBSCRIPTIONS_ENABLED) ([5da6bb7](https://github.com/inite-ai/inite-brain-service/commit/5da6bb7484325fd83652dfea94e484f89b2d886e))
* **engine:** V10 — grounded fixes from the V9 diagnosis set ([8834593](https://github.com/inite-ai/inite-brain-service/commit/8834593bc33a7b57d611c2c24df8036f39a5ca64))
* **engine:** V4 carried fixes — derive failure propagation, W2/W4 read-path work, S5.2 shrink ([77badab](https://github.com/inite-ai/inite-brain-service/commit/77badab3f51df042d687aed1dbf6b8e5966337e0))
* **engine:** V9 ALL-IN on BEAM — lifecycle, mention-scan, topic arcs, abstention, salience v2 ([04b0d5d](https://github.com/inite-ai/inite-brain-service/commit/04b0d5de9823bb221e07111b91087e26c2e886c0))
* **engine:** verbatim-recall evidence + date/lexicon engine defaults (2026-08 wave) ([9b1064b](https://github.com/inite-ai/inite-brain-service/commit/9b1064bfcc9cca9f4a4d20ef3ccaebc4956f437f))
* **entities:** entity-name autocomplete over the edge-ngram prefix index ([68ac370](https://github.com/inite-ai/inite-brain-service/commit/68ac3703b4b65c4811c96ac33f407984a3a4cc64))
* **episodes:** public episodes API + NDJSON export (EPISODES_API_ENABLED) ([2148631](https://github.com/inite-ai/inite-brain-service/commit/21486313e64a337123234aad0fa22ec189655c64))
* **eval:** --persona-hint flag for first-person world axes (measured null on BEAM) ([1be8c7f](https://github.com/inite-ai/inite-brain-service/commit/1be8c7f286dd3455f586c899769dd7a2ed3a259f))
* **eval:** --sample-offset selects held-out LoCoMo conversation blocks ([a3f8ad2](https://github.com/inite-ai/inite-brain-service/commit/a3f8ad263037982f10f918bac792c8e7863d3d38))
* **eval:** BEAM official nugget judge (--nugget-judge) with protocol-bug fixes ([0d0eb80](https://github.com/inite-ai/inite-brain-service/commit/0d0eb80a8aa981bf2b7ea40fe1b126ebdd288e1a))
* **eval:** BEAM scale-decay axis + resumable full-run harnesses ([7bb6b36](https://github.com/inite-ai/inite-brain-service/commit/7bb6b3645b6cf66d8a631a451c544362de684932))
* **eval:** LongMemEval-S harness — the capacity axis + token accounting ([6b57005](https://github.com/inite-ai/inite-brain-service/commit/6b5700593503f6315aa802f66b60a7e6b340f13b))
* **eval:** offline BEAM nugget re-scorer — the V11 §1 calibration tool ([d14ebb9](https://github.com/inite-ai/inite-brain-service/commit/d14ebb9ddc928a7ed477bd5972bb709d8bb9f45b))
* **eval:** offline tau_norm re-scorer + ladder results doc (B0 base, B1 loser) ([23525bf](https://github.com/inite-ai/inite-brain-service/commit/23525bfa595093aefeb7140f4e417d6ac23bc5c7))
* **eval:** paired McNemar + report summary tools for BEAM legs ([c4db865](https://github.com/inite-ai/inite-brain-service/commit/c4db865efd04f503f421da37f197dedb11c791c8))
* **eval:** V1 — self-describing report headers (git SHA + resolved profile) ([31a9f48](https://github.com/inite-ai/inite-brain-service/commit/31a9f481bba9468440eb2582ba0fa8a6101e6a8e))
* **extractor:** E3b object normalization — clean value alongside the grounded span ([1bfa08f](https://github.com/inite-ai/inite-brain-service/commit/1bfa08f4c0d6ec762a80be8bca61881e4597da89))
* **facts:** fn::cascade_retract — atomic derivedFrom cascade as a stored fn ([8a0790b](https://github.com/inite-ai/inite-brain-service/commit/8a0790bc2c40e4085fd9b72586ebb56cb8e0f55b))
* **gates:** S5.1 flag-budget gate — engine-behavior flags locked to a golden file ([31eec33](https://github.com/inite-ai/inite-brain-service/commit/31eec335ddc02b1450f06f4e4942b5634e0db61d))
* **gates:** S5.2-6 — env boundary, boolean idiom, layering, dead exports, lane registry ([8d8e7bf](https://github.com/inite-ai/inite-brain-service/commit/8d8e7bfd12e52405cc7a9d3fb4ad536372618458))
* **ingest:** contextual fact embedding (flag-gated, needs re-ingest) ([8e98e7a](https://github.com/inite-ai/inite-brain-service/commit/8e98e7abc4fc82dd2fc8e08e95aa462308a367cd))
* **ingest:** day-granular slot supersede + separate slot cosine gate — 0084 (V10 §1) ([0c017e7](https://github.com/inite-ai/inite-brain-service/commit/0c017e7fd962c741554a673e47f734140ef7d4c4))
* **ingest:** dialogue-mode extraction + batched fact resolution ([d8ca7fe](https://github.com/inite-ai/inite-brain-service/commit/d8ca7fe2ae2680effd35703983d49ba5d412d1e2))
* **ingest:** event-time extraction — validFrom from the clause, not the message ([206fa33](https://github.com/inite-ai/inite-brain-service/commit/206fa3337f1ec6ced46f633c511351fc775e92fb))
* **ingest:** speaker coreference — attribute first-person facts to speaker ([3ead6b7](https://github.com/inite-ai/inite-brain-service/commit/3ead6b75d8a1e36452db798b4d0feda15f46bdca))
* **locomo:** LLM-as-judge scoring mode ([391d733](https://github.com/inite-ai/inite-brain-service/commit/391d733130899bc564b9a9db349cc070214129d8))
* **locomo:** official-protocol scoring (cat1-4 headline, cat5 abstention) ([289ff4b](https://github.com/inite-ai/inite-brain-service/commit/289ff4b6d3417488692e81c352e9d02b6e4bb683))
* **memory:** derived worlds as forks — live-pin guard, atomic flip, residual GC ([9ef07a2](https://github.com/inite-ai/inite-brain-service/commit/9ef07a2444b8b7f13a785346db61b1a7932ee27b))
* **memory:** dialogue-mode new files — recompose, LIVE subs, facet routing, changefeed-row ([81b0adf](https://github.com/inite-ai/inite-brain-service/commit/81b0adf42fb8227bfa974a4392096ca467ba302a))
* **memory:** session-window deriver + versioned derivation namespaces (P3 v1) ([acb5c0b](https://github.com/inite-ai/inite-brain-service/commit/acb5c0b1426d82bc3f8f5c72655d362826340b3a))
* **retrieval:** V11 session — coverage-lane lexical OR-rewrite, KNN idiom fix, digest stack, edge-read fence ([fd89653](https://github.com/inite-ai/inite-brain-service/commit/fd896538b914cbcd7bb77a0dd40038d3a1f7e03e))
* **scoring:** importance/salience scoring — DERIVER_SALIENCE_STAMP + RETRIEVAL_SALIENCE_SCORING ([#262](https://github.com/inite-ai/inite-brain-service/issues/262)) ([39c48f4](https://github.com/inite-ai/inite-brain-service/commit/39c48f47bdfb6cd8e890450b2608420a6ed1a546))
* **search,synthesize:** HNSW dense legs for the coverage scan lanes (V11 §5 scale gate) ([fa3f085](https://github.com/inite-ai/inite-brain-service/commit/fa3f0852fddd1d8a13a3934e09c3fa0b4fb33ec1))
* **search:** BM25 match snippets via search::highlight (flag-gated) ([01c9966](https://github.com/inite-ai/inite-brain-service/commit/01c99664e7adb569c76435533f9a70ba77a69714))
* **search:** chatter demotion + fact-window shaping (flag-gated, default-safe) ([d94a42e](https://github.com/inite-ai/inite-brain-service/commit/d94a42e1a670e90312509f732cd1201172f073e3))
* **search:** combined vector+graph candidate-gen in one SurrealQL query ([ad5c4c6](https://github.com/inite-ai/inite-brain-service/commit/ad5c4c6570988c1132d35e559187e0ace11fdf43))
* **search:** entity-expansion second retrieval (profile entityExpansion) ([95ad3ae](https://github.com/inite-ai/inite-brain-service/commit/95ad3aeffe1ef364f3274987d88924751a8246f4))
* **search:** L0 segment lane — verbatim segments as first-class retrieval units (R1) ([ceffb77](https://github.com/inite-ai/inite-brain-service/commit/ceffb77ff7021fbf5feec74242f0c58fe59eb63b))
* **search:** qualified insight lane — RETRIEVAL_INSIGHT_EVIDENCE (off|routed), default off ([#258](https://github.com/inite-ai/inite-brain-service/issues/258)) ([32dbd18](https://github.com/inite-ai/inite-brain-service/commit/32dbd1824a40896dc3fcf5625cd7d1f738f66632))
* **search:** read-path Phase A — fact-centric ranking, occlusion, evidence-union ([323a57a](https://github.com/inite-ai/inite-brain-service/commit/323a57a2177a27e03ed3f150b28db2dba9e2b9e9))
* **search:** temporal overlap boost via profile temporalMode ([5017c6b](https://github.com/inite-ai/inite-brain-service/commit/5017c6b80b065d830364b93996598f6e64359184))
* **search:** verbatim routing by question shape + segment prompt budget ([f8db9f3](https://github.com/inite-ai/inite-brain-service/commit/f8db9f34889071ec4ce97f02111609b64474739f))
* **search:** verbatim segments as a scored fusion leg (profile 'fused') ([813f6fa](https://github.com/inite-ai/inite-brain-service/commit/813f6fa51a09429d1554542d217d508a1664f0cc))
* **synthesize:** answer-level abstention mode — abstentionCalibration='verifier' ([00a856e](https://github.com/inite-ai/inite-brain-service/commit/00a856eff845bf43f386f2f0c4913ae7ad29a854))
* **synthesize:** conflict frame v3 — pair classification (denial hedge / value commit) ([93aa9bf](https://github.com/inite-ai/inite-brain-service/commit/93aa9bfb9aee5826d4907e7a3e84f598a4227b9b))
* **synthesize:** date-arbitrated conflict frame — V10 §2b (updateStoryRendering) ([f334fb5](https://github.com/inite-ai/inite-brain-service/commit/f334fb58b300717047b95784382ed8a622c406b7))
* **synthesize:** mention-scan timeline mode + memory-coverage abstention (V9 §2 + §4) ([66f7340](https://github.com/inite-ai/inite-brain-service/commit/66f7340cb62978445ca22acf3ba38012caf1c58f))
* **synthesize:** minicheck abstention arm (V11 §2 arm b) — local NLI judge ([924d284](https://github.com/inite-ai/inite-brain-service/commit/924d284722b6996a9d8386d95a8dcdaa0f15ae67))
* **synthesize:** never-abstain 'answer' guardrail mode for QA settings ([266cd1d](https://github.com/inite-ai/inite-brain-service/commit/266cd1db36b4562477a403a3789beb2556239c3e))
* **synthesize:** ordering frame + aspect dedup — orderingFrame (V10 §3) ([c0d1d9f](https://github.com/inite-ai/inite-brain-service/commit/c0d1d9f15b7dab89c693cfec5dec03da6789acfd))
* **synthesize:** provenance lane — quote source turns of evidence facts (A1) ([7fab2f1](https://github.com/inite-ai/inite-brain-service/commit/7fab2f1d3fb2444cd8f28189cce4afcecc118d84))
* **synthesize:** query-time arc assembly — insightEvidence='query_arc' (V10 §4) ([f254010](https://github.com/inite-ai/inite-brain-service/commit/f25401042e1c1ef4cc8b25efe91002f1fdf21eaa))
* **synthesize:** RETRIEVAL_COVERAGE_LEX_MODE — lexical-leg OR-rewrite for the coverage scan lanes (V11 A2) ([b0704ed](https://github.com/inite-ai/inite-brain-service/commit/b0704ed17b0c5dab2f7f4666f99b57483f0bc93a))
* **synthesize:** RETRIEVAL_DIGEST_EVIDENCE — digest lane, read side (V12 §2) ([b5e5d95](https://github.com/inite-ai/inite-brain-service/commit/b5e5d9527edf8991498caaae7d253392f613bcb4))
* **synthesize:** router lexicon v2 — gaps measured live on the LME-500 leg ([d167c9c](https://github.com/inite-ai/inite-brain-service/commit/d167c9cdc41b702321fbb21ffae0c5397a83437b))
* **synthesize:** SYNTHESIZE_LANES_DISABLED — per-lane ablation for the typed dispatcher ([a2b9dfb](https://github.com/inite-ai/inite-brain-service/commit/a2b9dfbf213a4936f829dd1cd40dde25eec8849f))
* **synthesize:** T1 typed dispatch — temporal-distance lane, arithmetic in code ([cafc790](https://github.com/inite-ai/inite-brain-service/commit/cafc7907242ec01cb2deffd951a827bc016b2854))
* **synthesize:** T1b event-interval table + harness asOf policy ([6ece933](https://github.com/inite-ai/inite-brain-service/commit/6ece93339637a0d28a7c164dbcc162da5f19bd75))
* **synthesize:** T2 enumeration + T3 contradiction lanes of typed dispatch ([0b41153](https://github.com/inite-ai/inite-brain-service/commit/0b411538ccd4f77623448cfe8b60c5242e938156))
* **synthesize:** T2b first-mention enumerator for mention-order questions ([fbacaf9](https://github.com/inite-ai/inite-brain-service/commit/fbacaf92985616c1c6844787f991a35bb4a89dbe))
* **synthesize:** T4 preference, T5 recency arbitration, T6 summary lanes — dispatcher complete ([a06f629](https://github.com/inite-ai/inite-brain-service/commit/a06f6294ecb9254ba728aafca16e08d87ff92b0d))
* **synthesize:** T6/T2 wide probe — PRF second retrieval for recall breadth ([cf11e6b](https://github.com/inite-ai/inite-brain-service/commit/cf11e6bfdc1b59f96d3faaf984a08c77fdc8c6b7))
* **synthesize:** T7 instruction lane — unconditional standing-instructions section ([dd7923b](https://github.com/inite-ai/inite-brain-service/commit/dd7923b00491ca1780b93ea54b6ace91fdb2ebe9))
* **synthesize:** timeline evidence for mention-order questions — RETRIEVAL_TIMELINE_EVIDENCE (off|routed) ([#266](https://github.com/inite-ai/inite-brain-service/issues/266)) ([e452112](https://github.com/inite-ai/inite-brain-service/commit/e45211232c360cefab7cf34e5e662dc6a272b1b3))
* **synthesize:** update-story rendering — updateStoryRendering (V10 §2) ([5602619](https://github.com/inite-ai/inite-brain-service/commit/560261977fbeeb81123d9c61e11db1f111569d32))
* **synthesize:** V4 carry tail — lane parallelism, one lane type system + leg results docs ([c214c27](https://github.com/inite-ai/inite-brain-service/commit/c214c27d02e95bef4ea8332bbfe648e462b5a757))
* **synthesize:** verifier topic-coverage audit — verifierTopicCoverage (V10 §5) ([c1d3ad3](https://github.com/inite-ai/inite-brain-service/commit/c1d3ad3ebee6f5670b78fb6c8f8d08ff06eea7fc))
* **synthesize:** verifierModel override (V11 §2 arm a) + reasoning-model verifier params ([57e4e6a](https://github.com/inite-ai/inite-brain-service/commit/57e4e6affc47f25d1547a4dc5e0750bcd414ee10))
* V7 profile points — verbatim routing, segment budget, deriver recall ([8b58984](https://github.com/inite-ai/inite-brain-service/commit/8b58984b8950923c40f78102adccc0ef6dc2c0eb))
* **write:** coined-predicate alias column + append_only default (W3) ([f737b4f](https://github.com/inite-ai/inite-brain-service/commit/f737b4fd385c0dfb5cdc757079ec20d3363dd9cd))
* **write:** coined-predicate alias column + append_only default (W3) ([17a6677](https://github.com/inite-ai/inite-brain-service/commit/17a6677ca9e7db93cdfc209c00e6c565c4006a03))


### Bug Fixes

* **admin:** bind operator_action ts as a Date on SurrealDB 3.x ([#256](https://github.com/inite-ai/inite-brain-service/issues/256)) ([d0c1eb2](https://github.com/inite-ai/inite-brain-service/commit/d0c1eb25cecbf74b388ba02b55a86737ade43cf4))
* **admin:** digest fold prompt-escape belt — prose-only rule + code/markup rejection ([9dac2c7](https://github.com/inite-ai/inite-brain-service/commit/9dac2c771eb1b0559c82cfff6ff6308e6a333c9d))
* **admin:** digest over-budget compress turn — the tail cap was eating the newest beats ([77b2903](https://github.com/inite-ai/inite-brain-service/commit/77b29037e512562079760f7b1a366cf6a3f23886))
* **admin:** operator_action audit write must omit null option fields ([22149b6](https://github.com/inite-ai/inite-brain-service/commit/22149b6accb850068dd6d2d0e695e97e6ec8484f))
* **admin:** operator_action audit write must omit null option fields ([3b9ed1a](https://github.com/inite-ai/inite-brain-service/commit/3b9ed1a375c660fb437a7c2b9783890a635e7510))
* **audit:** config guard, never-abstain floor, default-safe backfill, temporal date ([e1af0fd](https://github.com/inite-ai/inite-brain-service/commit/e1af0fdb80e9b514e572cc09d1d792697f02a2d1))
* **compaction:** W2 — compact inside the tenant live world, not across it ([dcad42c](https://github.com/inite-ai/inite-brain-service/commit/dcad42c9889d39f551c83ba5f5a7d00479663043))
* **composers:** atomic staging-swap for segments and aggregates ([1ef9188](https://github.com/inite-ai/inite-brain-service/commit/1ef918849ca574f19772f60032815b5f6991533b))
* **config:** W6 — one boolean idiom, catalogue truth gates, NUL-byte purge ([cdb213f](https://github.com/inite-ai/inite-brain-service/commit/cdb213f44aaec64ac97f6d7b6382adcbbca11b92))
* **deps:** sync pnpm-lock with chrono-node ^2.10.0 manifest bump ([8b22fe0](https://github.com/inite-ai/inite-brain-service/commit/8b22fe0b5524311c39c6f3fe5adbe8737418f7dd))
* **derive:** propagate derive failures instead of WARN+201 ([8b8d3ae](https://github.com/inite-ai/inite-brain-service/commit/8b8d3aea6bfba0df6b6e8b038c19bb5f91ba0ef6))
* **deriver:** W0 — gc keep-set from the registry, refuse on empty (audit [#8](https://github.com/inite-ai/inite-brain-service/issues/8)) ([8229ebe](https://github.com/inite-ai/inite-brain-service/commit/8229ebea0eaaf617ae4bd4e0a66b6ce2609a8c7a))
* **deriver:** W3 — derived rows carry the fields the read path assumes ([eff089a](https://github.com/inite-ai/inite-brain-service/commit/eff089a04e561e36b24283b7627a72a09f003bbf))
* **dreams:** fence every leg to the tenant's live derived world ([209c6b0](https://github.com/inite-ai/inite-brain-service/commit/209c6b0afa06ce158f4787d4dae3061615f8e0e7))
* **driver:** 0076 — FLEXIBLE goes after TYPE (3.x parser) ([268bb81](https://github.com/inite-ai/inite-brain-service/commit/268bb8176a122dbd4c542735c1bf0561699df7c9))
* **engine:** V10.5 audit wave — lane fixes, HNSW scan legs (V11 §5), refactors ([cd8e529](https://github.com/inite-ai/inite-brain-service/commit/cd8e5293ea50ef40cc2a3ef77f34d8b6c55a5d90))
* **eval:** ABSTAIN_RE covers the guardrail sentinel — LME abstention was 17/18, not 2/18 ([5db02fb](https://github.com/inite-ai/inite-brain-service/commit/5db02fbf3c923a22e986af173803376052b1428d))
* **eval:** LoCoMo ingest renders image captions into mention text ([0a0b2d2](https://github.com/inite-ai/inite-brain-service/commit/0a0b2d24c8fc7113e5939828c2cd51393b9fa9c8))
* **eval:** TenantClient on node:http — undici headers timeout killed live derive calls ([895cb16](https://github.com/inite-ai/inite-brain-service/commit/895cb167bfee72bbd75b50902db9526fa18b111c))
* **eval:** TenantClient retries transient failures with backoff ([6ca75ae](https://github.com/inite-ai/inite-brain-service/commit/6ca75ae835a78a315a96eb5c5c307c7eabf42dce))
* **extractor:** W3 — dedup keys on the subject, facet routing gated on its profile ([b6bea02](https://github.com/inite-ai/inite-brain-service/commit/b6bea02481d544f033b807ae5745b21d6278390f))
* **gdpr:** 0080 — tombstone fields for the L0 forget cascade counters ([89cfa0c](https://github.com/inite-ai/inite-brain-service/commit/89cfa0c8e8eaf82a02fd6e4c5a77de9768bf7be3))
* **ingest,admin:** audit wave — config hygiene + 0085 pairwise slot closure ([3bf46c7](https://github.com/inite-ai/inite-brain-service/commit/3bf46c777ba42d9bfe7de5ffd8c0ed188e9deaf0))
* **lint:** unblock [#270](https://github.com/inite-ai/inite-brain-service/issues/270) CI — import over require in ordering-frame spec, drop unused traceArtifact ([68b6141](https://github.com/inite-ai/inite-brain-service/commit/68b6141c0586c9a86a0b01576f75d1b0f847ef8a))
* **locomo:** coerce non-string gold answers so token-F1 doesn't crash ([d8526a2](https://github.com/inite-ai/inite-brain-service/commit/d8526a2381c40470891f258ed1946d5b20a10384))
* **locomo:** harness integrity — honest retry claim, drop provenance, cat5 errors ([aa98cee](https://github.com/inite-ai/inite-brain-service/commit/aa98cee139f5af33425f687f9f7b49c286a4bdda))
* **locomo:** resilient ingest — retry transient failures, don't abort the run ([b074b6a](https://github.com/inite-ai/inite-brain-service/commit/b074b6a71fc6bbfc8528d9f11a628810c5a753e7))
* **memory:** deriver survives impossible occurred_on dates + targeted re-derivation ([8941fa8](https://github.com/inite-ai/inite-brain-service/commit/8941fa873ed78c35d466a2b40848824895ff1dc6))
* **multi-hop:** malformed planner asOf degrades instead of 500ing the request ([e4fb0d7](https://github.com/inite-ai/inite-brain-service/commit/e4fb0d721c1f254b497f334edf0998b641248f3f))
* **multi-hop:** synthesize on single-hop plans (was returning empty answers) ([36d664f](https://github.com/inite-ai/inite-brain-service/commit/36d664fbd2568f6ef03f44d75d2e5e76f1b7a6e0))
* **privacy:** W1 — erasure reaches L0, user scope fences the raw substrate ([d05f8e3](https://github.com/inite-ai/inite-brain-service/commit/d05f8e391c2b9ae5c242f7cfb78f04beb6ff46ba))
* **registry:** kill the canonicalize snapshot storm (open-vocab O(n^2)) ([f9ccb18](https://github.com/inite-ai/inite-brain-service/commit/f9ccb1876af1d88f9d57ecc70b828198d8b3f50c))
* **scripts,common:** parity gate machine-readable verdict + real health version ([4b9b7b9](https://github.com/inite-ai/inite-brain-service/commit/4b9b7b9abc98b2e85cf78f36d3731eab567dcc33))
* **search,ingest,dreams:** vector::distance::knn() idiom for the three legacy KNN legs (V11 A4) ([d914f00](https://github.com/inite-ai/inite-brain-service/commit/d914f00a41247e24e6808d80f136b410cbcdc13a))
* **search:** edge-read policy fence + graph config-catalog truth (graph research 2026-08, action 1) ([c6b4917](https://github.com/inite-ai/inite-brain-service/commit/c6b49171e575bd344c9866890091b0bfcfe93467))
* **search:** fused honours segmentTopK; abort checkpoints in synthesize lanes ([5334f62](https://github.com/inite-ai/inite-brain-service/commit/5334f62ca260e0d22970699efcfc5bdc27886c68))
* **search:** fused honours segmentTopK; abort checkpoints in synthesize lanes ([33e6b42](https://github.com/inite-ai/inite-brain-service/commit/33e6b4206126c0486abc9866c926c3af46588713))
* **search:** make verbatimEvidence=routed reachable and make it fire on the SSA genre ([#257](https://github.com/inite-ai/inite-brain-service/issues/257)) ([0021897](https://github.com/inite-ai/inite-brain-service/commit/00218975c98d945e1bbc4b53863bfcf811564a97))
* **search:** routed dispatch keys on verbatim shape, not timeline shape ([070d37d](https://github.com/inite-ai/inite-brain-service/commit/070d37dde14a4a3925217673c690942729dbf554))
* **search:** W4 — fact-centric layers over the ranking, local reranker on by default ([918df75](https://github.com/inite-ai/inite-brain-service/commit/918df7577ed2575460d805db69e83121ba865ef4))
* **synthesize,admin:** normalize datetime columns to ISO before day-slicing ([54bd759](https://github.com/inite-ai/inite-brain-service/commit/54bd7590337eed797de4dedebdd4e9adac3ede3c))
* **synthesize:** KNN legs project vector::distance::knn(), not a fresh cosine + EXPLAIN guard ([a5346d5](https://github.com/inite-ai/inite-brain-service/commit/a5346d5ce35bb11d80138cac00fb795522f06cea))
* **synthesize:** minicheck verdict falls through the shared finalize gate + line-budget repair ([8614b8c](https://github.com/inite-ai/inite-brain-service/commit/8614b8c88b9b4369e2d14069e7ba1ef6c7f8f5de))
* **synthesize:** ordering frame v2 — specificity survives the list shape ([8efa80d](https://github.com/inite-ai/inite-brain-service/commit/8efa80dfd9ec3f0c6c312121c5d9cd433f36de99))
* **synthesize:** ordering record — strip exact-N scaffold, segment-level mentions (V10 §3 R1) ([e1ef931](https://github.com/inite-ai/inite-brain-service/commit/e1ef931a8120aa71203a26335c7ff2a3ac6ab856))
* **synthesize:** router surgery from the BEAM A/B — between-events and update-negations ([3676f13](https://github.com/inite-ai/inite-brain-service/commit/3676f1390ae571654ef86344f1fcc098577d4698))
* **synthesize:** row-policy seam on fact lanes + one user-scope pin per request ([981709b](https://github.com/inite-ai/inite-brain-service/commit/981709b1dc1e10fff2f305ef325a565ca1c5a142))
* **synthesize:** surface fact validity window so temporal questions answer ([6822531](https://github.com/inite-ai/inite-brain-service/commit/6822531288f19d291f6fa27c67a436bf1a169ae9))
* **synthesize:** W5 — verification and citations cover the whole prompt ([47e4dc3](https://github.com/inite-ai/inite-brain-service/commit/47e4dc35deffb37d24eab7cae8c398622a4ead83))
* **synthesize:** zero-score BM25 matches count as lexical mentions + scan parity e2e ([65ebddc](https://github.com/inite-ai/inite-brain-service/commit/65ebddc45daf18987dac585a32a7f0d3fb7c32aa))
* **versions:** W2 — the projection registry is the read pin, per tenant ([c7e6cdb](https://github.com/inite-ai/inite-brain-service/commit/c7e6cdb4f148016e1bff010e874ae71c63532f67))


### Performance Improvements

* **admin:** batch multi-row INSERTs in deriver and segment composer ([6ee70e2](https://github.com/inite-ai/inite-brain-service/commit/6ee70e28322cd45d1a8fa027b5b3e5124fe91d27))
* **ingest:** batch mention edge RELATE into two round-trips (INGEST_BATCH_EDGES) ([ea3c5f2](https://github.com/inite-ai/inite-brain-service/commit/ea3c5f26845e8d9f56d27d1da84da8017ec94070))
* **ingest:** HNSW approximate KNN for inline entity-resolution name scan ([5dbbfe2](https://github.com/inite-ai/inite-brain-service/commit/5dbbfe2964ab15a251b56f69841a2d325146de0f))
* **search:** release the scoped connection before rerank LLM awaits ([f9195eb](https://github.com/inite-ai/inite-brain-service/commit/f9195eb6a6bcb301891a2d500daaa0c13b545527))
* **synthesize:** parallelize lane collection ([0f9b868](https://github.com/inite-ai/inite-brain-service/commit/0f9b868c081fced0be524053da07e4cc38aa7453))


### Reverts

* **agent-qa:** restore prior answer prompt — the rewrite regressed LoCoMo ([0cc6162](https://github.com/inite-ai/inite-brain-service/commit/0cc61622a458648cac53cd7de8a05d202326c766))


### Code Refactoring

* **engine:** S1 — delete measurement-killed forks, code paths included ([1c2e295](https://github.com/inite-ai/inite-brain-service/commit/1c2e2955ae06c38fc47ca66094b921100e2b503d))
* **engine:** S2 — fold the default-on winners into the single path ([13efb1e](https://github.com/inite-ai/inite-brain-service/commit/13efb1ea8b7fa3f9ec57e29b7c3f1df580529280))
* **engine:** S3 — RetrievalProfile object + first-class Lane registry ([95d3300](https://github.com/inite-ai/inite-brain-service/commit/95d330071d357d89d2ae36921097fd745acd31dd))
* **extraction:** S4 — one extraction pipeline profile + one write primitive ([4431605](https://github.com/inite-ai/inite-brain-service/commit/4431605eb02dbac3735614c86c3048a2a9a3ac49))

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
