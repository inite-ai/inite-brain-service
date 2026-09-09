# Embedding spaces — space as stored state, never as a query-time union (2026-09)

Design memo for the layer under [#503](https://github.com/inite-ai/inite-brain-service/pull/503) (`0cd331c`), which
made a width mismatch unrepresentable in TypeScript. This asks the next question — should the
embedding space become a first-class partition key — and answers it **narrowly yes and loudly
no**. Yes: a space must become *stored, typed, and per-row*, so that a model change is a
migration instead of a drop-and-rebuild. No: two spaces must never be live in one query's
candidate pool, because the repo has already measured that its fact-level fusion cannot survive
it and the literature says the union buys nothing that a reranker would not buy more cheaply.

The one-line thesis: **0101 named the zero-downtime protocol but the schema cannot express step
one of it** — a row holds exactly one vector, so the "shadow dual-write" the migration doctrine
depends on has nowhere to land. Making space a partition key therefore means one concrete thing:
**a vector column per space**, with the tenant's active space choosing which column is read.
Everything else — the canonical id, the state row, the cutover statement, the sweep — is already
built and waiting for it.

Companion to [multilingual-2026-08.md](multilingual-2026-08.md) (whose Tier 2 built the space
machinery) and [multi-vector-2026-08.md](multi-vector-2026-08.md) (which reuses it per modality).
All SurrealDB claims below were measured on a scratch `surrealdb/surrealdb:v3.2.4` container, not
read from docs; §3 gives the exact behaviours.

---

## 1. The verdict, up front

**Keep single-space serving. Build the migration path. Do not build multi-space retrieval.**

Concretely, in priority order:

1. **The degraded mode is wrong and is the only user-visible bug here.** Today a warmup failover
   silently answers queries from a foreign space; [#504](https://github.com/inite-ai/inite-brain-service/pull/504)
   (open) turns that into a 503. Both are wrong. The dense lane going away is not an outage — on
   this workload class it is a small, measurable quality loss (§4.3) — and the pipeline already
   has a first-class `'lexical'` mode that skips the vector leg. **Demote, don't fail.**
2. **Make the space real in the substrate, not just in TypeScript.** SurrealDB 3.2.4 supports
   `array<float, N>` and enforces it on write (§3, S1). One `DEFINE FIELD OVERWRITE` per vector
   column converts #503's build-time gate into a substrate invariant that also closes the writers
   #503 could not reach — the external-centroid ingest above all (§2, D7).
3. **Give each space its own column, and migrate column-to-column.** That is the only shape
   SurrealDB can express (§3, S3–S5), it is what Qdrant shipped as "named vectors" and documents
   as the *preferred* migration path, and it makes the dual-write window representable for the
   first time.
4. **Never fuse two spaces.** Not at score level (the fact pipeline's convex fusion is
   magnitude-sensitive *by measurement* — `fusion.ts:19-29`), not at rank level mid-backfill
   (RRF's no-penalty-for-absence turns partial coverage into ranking-by-ingestion-recency, §4.2).
   A tenant is wholly in one space at query time, always.

**Why not full multi-space serving.** The forcing function is weaker than it looked. On MMTEB
*retrieval*, bge-m3 scores 80.76 and the shape-compatible successor Qwen3-Embedding-0.6B (1024-d,
Apache-2.0, MRL) scores 80.83 — a swap buys nothing. Real gains need the 4B/8B tier (85.05 /
86.40) at 7-13× the compute and 2560/4096 dims
([Qwen3-Embedding README](https://github.com/QwenLM/Qwen3-Embedding)). So the migration we must
be able to perform is a **large-jump, dimension-changing** one, some day — not a like-for-like
swap, soon. That argues for building the *path* and not the *parallelism*. And the quality case
for two live spaces is thin on its own terms: the only direct modern measurement of fusing two
dense retrievers over one corpus finds small, pair-dependent, sometimes-negative gains and states
plainly that a strong+weak pair is pointless
([WOWS 2025](https://ceur-ws.org/Vol-4137/WOWS_2025_paper_4.pdf)), while a cross-encoder on a
single retriever buys +4.5 to +5.5 nDCG reliably
([arXiv 2212.06121](https://arxiv.org/abs/2212.06121)).

---

## 2. Diagnosis — what is actually wrong today (each verified on this branch)

| # | Finding | Evidence |
|---|---|---|
| **D1** | **0101's dual-write is unrepresentable in 0101's own schema.** The protocol is written down as begin → reindex → cutover, but every table has exactly one vector column and one singular `embeddingSpaceId`. Two vectors of different widths cannot coexist on a row, so "new writes are produced in BOTH the active space and the target space" has nowhere to land. | `embedding-space.service.ts:14-25` (the protocol), `0101_embedding_space.surql:42-75` (one `option<string>` stamp per table), `embedding-space.ts:210-224` (one vector column per table) |
| **D2** | **The whole space state machine is dead code.** `activeSpaceFor` / `targetSpaceFor` have zero callers outside the class; no search leg filters on `embeddingSpaceId`. The class says so itself. | `embedding-space.service.ts:88`, `:100`, and the SCOPE NOTE at `:32-38` |
| **D3** | **The cutover surface is armed and inert.** `POST /v1/admin/embedding-space/cutover` atomically flips `activeSpace` — a field nothing reads. An operator can run the documented three-step migration to completion and change nothing. | `admin-embedding-space.controller.ts:69-78`; recommended order documented at `:29-30` |
| **D4** | **The failover is still cross-space by default in prod.** `servingProvider()` returns the OpenAI fallback whenever bge-m3 is not warm; the strict guard is behind `EMBEDDING_SPACE_STRICT`, default `'0'` and absent from the deploy env. #504 flips it default-on — to a **503**, not a lane demotion. | `embedder.service.ts:409-413`, `:466-488`; catalog default `config-catalog.data.ts:1081-1089` |
| **D5** | **The correct degraded mode already exists and is unreachable from a failure.** `mode === 'lexical'` skips the vector leg entirely and `fuse()` short-circuits to BM25. It is reachable only from a caller-supplied DTO field, never from the embedder being unavailable. | `search.service.ts:404`, `search-retrieval.service.ts:58`, `fusion.ts:68-76`; the same idiom already used deliberately at `scene-lane.service.ts:106` |
| **D6** | **The dense leg is a single point of failure for the entire search request.** `embed(query)` at `legs.ts:68` is outside any try; the legs run in a bare `Promise.all`, so a rejection kills the lexical leg with it and the request 5xx's. Three synthesize lanes already do this correctly with an inner try. | `legs.ts:68`, `search-retrieval.service.ts:57`; correct pattern at `fragment-lane.service.ts:122-128`, `belief-lane.service.ts:121-128`, `scene-lane.service.ts:209-219` |
| **D7** | **An admin-supplied centroid bypasses every guard.** `lens_suppression.centroid` is a vector column that is cosine-compared, has **no** `embeddingSpaceId` field, and is validated only for finiteness — not width, not space. #503's write guard cannot reach it because the vector never touches the embedder. | `lens-admin.controller.ts:77-78`; column classified at `embedding-space.ts:219`; no stamp in 0101 or later |
| **D8** | **`knowledge_fact.altEmbedding` has an index and no writer.** `HnswMaintenanceService` builds `fact_alt_embedding_hnsw` over it; the reindex sweep only ever writes `'embedding'`; nothing in `src/` reads or writes `altEmbedding`. It is a dead column carrying a live index. | `hnsw-maintenance.service.ts:99-100`, `reindex-engine.service.ts:257`, and `grep -rn altEmbedding src/` returning only declarations |
| **D9** | **The reindex is a destructive in-place rewrite: not resumable, no space target, no rate limit.** `UPDATE $id SET embedding = $embedding` overwrites the only copy; `offset` is process-local so a crash restarts at 0; the target space is whatever `EMBEDDER_PROVIDER` says, so "reindex into space X" requires a restart. Mid-sweep, half the corpus is in each space and every dense read is meaningless for one half. | `reindex-engine.service.ts:208-224` (write), `:240-245` (offset pagination), `:176-179` (space comes from the provider) |
| **D10** | **The index rebuild is total and synchronous — and at real scale it does not merely block, it fails.** `create` REMOVEs all four indexes and DEFINEs them in one statement, so the tenant is index-less for the duration. Measured: that DDL over 20 000 × 1024-d **fails after ~133 s** with a RocksDB transaction conflict (§3, S10). The docstring treats the cost as time. | `hnsw-maintenance.service.ts:92-105`, docstring at `:51-52` |
| **D11** | **A missing HNSW index does not error — it silently returns unranked rows.** `SEARCH_HNSW_ENABLED=1` is set in production and index creation is a manual per-tenant admin call, so any un-indexed tenant takes this path. The documented catch-and-fall-back-to-scan never fires. | `deploy-brain.yml:178`; `legs.ts:74-79` (the dead catch), `hnsw-maintenance.service.ts:15` (manual per tenant); measured in §3, S7 |
| **D12** | **Four of the thirteen vector columns are unreachable by any sweep.** `derived_representation.embedding`, `semantic_belief.embedding`, `lens_suppression.centroid` and `knowledge_fact.altEmbedding` are in `VECTOR_COLUMNS` but not in `ADDITIONAL_TABLE_SPECS`; `semantic_belief` and `lens_suppression` do not even have an `embeddingSpaceId` column. A "full" reindex is not full. | `embedding-space.ts:210-224` vs `reindex-engine.service.ts:52-105`; `0126_belief_serving_search.surql:28` |
| **D13** | **Two spaces cannot be fused at the fact level, by our own measurement.** `fuse()` is convex over normalised *scores* with a fixed 0.5 weight, and the code records why RRF was rejected: recall@1 0.85 → 0.43 on the quality eval. Cosine magnitudes are not comparable across models, so score fusion across spaces is exactly the thing the convex choice cannot tolerate. | `fusion.ts:19-29`, `:30`, `:79-99`. Lane-level RRF (`segment-lane.service.ts:204-224`, k=60) is a different doctrine and does not rescue this |

---

## 3. What SurrealDB 3.2.4 can actually express (measured, not documented)

Probed against a scratch `surrealdb/surrealdb:v3.2.4` container (rocksdb, 8 GB, port 3057). The
`brain-meas-3055` and `loco-321` stands were not touched.

| # | Capability | Result |
|---|---|---|
| **S1** | `DEFINE FIELD v ON t TYPE option<array<float, 1024>>` | **Supported and enforced.** A wrong-width write is refused: `Couldn't coerce value for field 'v': Expected 'none \| array<float, 4>' but found [...]`. Too-short is refused identically. Works with HNSW and `vector::distance::knn()`. |
| **S2** | Tightening an existing unsized column | `DEFINE FIELD OVERWRITE` succeeds **without re-validating existing rows**. Afterwards any `UPDATE` to a non-conforming row fails — **including an update to a different field**. Repair path: `UPDATE $ids UNSET v` or `SET v = NONE` (both work), `DELETE` also works. **Purge before tightening.** |
| **S3** | Two HNSW indexes, different DIMENSIONs, different columns, same table | Supported. This is the multi-space primitive. |
| **S4** | Partial / filtered index (`DEFINE INDEX ... WHERE`) | **Parse error.** One column can carry exactly one space. |
| **S5** | Two indexes on the *same* field | Both are created; the planner picks one, unspecified (observed: the later-defined). **There is no alias-swap primitive.** |
| **S6** | Wrong-width write when an HNSW index exists | Rejected: `Incorrect vector dimension (6). Expected a vector of 4 dimension.` With **no** index — the default for every tenant — it is accepted silently. This is why #503's blast radius was what it was. |
| **S7** | `<\|K,EF\|>` with **no** index | **No error.** `EXPLAIN` shows a bare `TableScan`, the KNN operator dropped from the plan; the query returns the first k rows in table order with `knnDist = null`. |
| **S8** | Mixed widths in one column | `vector::similarity::cosine` errors for the **whole query**; `<\|K,COSINE\|>` **silently skips** the mismatched rows. |
| **S9** | `DEFINE INDEX ... CONCURRENTLY` | **Supported.** Returns in ~20 ms, builds in background, queries work throughout. `INFO FOR INDEX <n> ON <t>` returns `{building:{initial,pending,status,updated}}` — a real progress surface. |
| **S10** | Synchronous vs concurrent HNSW build, 20 000 × 1024-d | **Synchronous: FAILS after 133 s** (`Transaction conflict ... MemTable only contains changes newer than SequenceNumber ...`). Reproduced after a 30 s settle: 140 s, same failure. **`CONCURRENTLY`: `ready` in 4.2 s** (~4 700 rows/s). |
| **S11** | Brute-force `vector::similarity::cosine` full scan, 20 000 × 1024-d | **OOM-killed the server** at both 6 GB and 8 GB (`OOMKilled: true`). Independently corroborates `scan-leg.ts:74-82` ("one such query OOM-killed a 16GB SurrealDB 3.1.5"). |
| **S12** | Space retirement | `REMOVE FIELD` does **not** delete stored values — the data is still returned. `REMOVE TABLE` does. Retirement needs an explicit `LET $ids = (SELECT VALUE id ...); UPDATE $ids UNSET col;`. |
| **S13** | Querying two spaces in one statement | Refused: *"KNN operators must appear at the top level of the WHERE clause (joined with AND); nesting `<\|k,…\|>` inside OR or NOT is not supported."* Two spaces = two round trips, always. |
| **S14** | Gate predicate beside the KNN operator | Pushed **into** the `KnnScan` node (visible in `EXPLAIN`). Load-bearing for the bitemporal/ABAC/retraction gates — and lost if vectors move to a side table. |
| **S15** | Storage | SurrealDB `float` is **f64**: a 1024-d vector is ~8 KB in the row, a 1536-d one ~12 KB. Matches the house cost model in `multi-vector-2026-08.md:91`. |
| **S16** | Other | HNSW `TYPE F16` / `TYPE I8` accepted (quantised index representation). **MTREE is gone in 3.2.4** — parse error. `DIMENSION` and the array width **cannot be parameterised** in DDL. |

Three of these change the design outright: **S1** (the substrate can enforce what #503 enforces in
TS), **S10** (our only index-build path is broken at the scale the index exists for, and the fix
is one keyword), and **S13/S14** (per-space *columns* on the same table are the only shape that
keeps gate push-down, so a side table or a per-space table is off the menu).

---

## 4. What the research changed

### 4.1 Matryoshka is a distraction here — say it plainly

bge-m3 is **not** MRL-trained; the M3 paper never mentions nested-prefix losses and downstream
tooling errors out on truncation attempts
([2402.03216](https://arxiv.org/html/2402.03216v3), [ReMe#69](https://github.com/agentscope-ai/ReMe/issues/69)).
More importantly, MRL would not help even if it were: a truncated-and-renormalised vector from
model A and a native vector of the same width from model B are both points on the same sphere and
their inner product carries no signal, because contrastive objectives are invariant under any
orthogonal transform — every model picks an arbitrary basis
([2510.13406](https://arxiv.org/pdf/2510.13406) proves the alignment bound). And MRL is not even
free within a model: a controlled study finds non-MRL embeddings truncate about as well up to ~80%
reduction ([2605.16608](https://arxiv.org/html/2605.16608v2)), an independent measurement finds
plain PCA beating MRL truncation below 512-d
([Castillo](https://dylancastillo.co/posts/matryoshka-vs-pca)), and ZeroEntropy measured a
0.02-0.03 nDCG@10 tax *at full width* for training with MRL at all
([ZeroEntropy](https://zeroentropy.dev/articles/matryoshka-is-dead/)).

**What survives:** MRL on the *successor* is an ops convenience, not a capability — Qwen3-0.6B can
be truncated to exactly 1024 so the new space drops into the existing column shape. Worth one line
in the space descriptor, not a selection criterion.

### 4.2 Never serve a half-built space — this is the one hard rule

There is no IR literature on rank-fusing a complete index with a partially-backfilled one, because
it is not a design anyone defends. The mechanism is deterministic rather than empirical: under RRF
a document absent from a list is simply not penalised, so at k=60 mere *membership* in the
intersection is worth roughly 15 rank positions. With space B at 40% coverage, 60% of the corpus is
structurally ineligible for that bonus and gets demoted as a function of backfill progress — the
index ranks by ingestion recency and degrades gradually enough never to look like an event.
Depth does not fix it: candidate depth k₀ ∈ {10, 100, 1000} fails to resolve weak-path
contamination ([2508.01405](https://arxiv.org/pdf/2508.01405), Fig. 8), and neither does a
reranker — *"it cannot recover documents missed during initial retrieval, making candidate quality
a hard ceiling"* (same paper, Table 5). The classic collection-fusion result and Elasticsearch's
per-shard-IDF problem are the same bug in older clothes.

Elastic reached the same conclusion by a different road and is worth citing as precedent: a PR to
allow one semantic query across multiple inference IDs was **closed unmerged** — *"we have decided
to not implement this feature due to scoring mismatch issues"*
([#120755](https://github.com/elastic/elasticsearch/pull/120755)) — and the eventual 9.2 feature
([#133675](https://github.com/elastic/elasticsearch/pull/133675)) works by embedding the query
once per inference ID and keeping the result sets **separate**. They solved cross-space search by
not comparing across spaces.

**Consequence for us:** the cutover must be atomic per tenant, and the backfill must land in a
column nothing reads until it is complete. Both are already the shape of `embedding_space_state`.

### 4.3 Dropping the dense lane is cheap *on this workload* — the number that settles §1.1

Aggregate BEIR says dense is worth a lot (BM25 ~0.428 vs ~0.61-0.63 for a top model). Conversational
long-term memory says the opposite about which lane you can afford to lose. The MemPro ablation on
LoCoMo ([2606.00619](https://arxiv.org/html/2606.00619)): gpt-4o-mini full **84.93**, without BM25
**72.25 (−12.68)**, without embedding retrieval **82.57 (−2.36)**; Qwen3-30B 77.85 / 65.44 (−12.41)
/ 75.67 (−2.18). A second, independent study on LoCoMo has BM25 alone at Hit@1 .640 vs dense .664
and fusion .752 — and reports that **RRF underperformed convex fusion** there too
([2606.04194](https://arxiv.org/html/2606.04194)), which is our `fusion.ts` finding arrived at from
outside.

So: **losing the dense lane on this workload costs roughly 2.4 points, losing the lexical lane costs
roughly 12.5.** A lexical-carry degraded mode is a defensible degraded SLA with a published
per-class delta. A 503 is not, and a cross-space answer is worse than either. §3 S11 closes the
argument from the other side: the "fall back to a brute-force scan" alternative OOM-kills the
database at 20k rows.

### 4.4 Compatibility groups are real in 2026 — record them, don't build for them

Two vendors now ship *deliberately compatible* spaces: Voyage 4's "shared embedding space" lets
voyage-4-lite queries retrieve voyage-4-large documents with no re-vectorisation
([Voyage](https://blog.voyageai.com/2026/01/15/voyage-4/)), and jina-embeddings-v5-omni's text
outputs are **bit-identical** to v5-text-small, "enabling migration without reindexing"
([Jina](https://jina.ai/models/jina-embeddings-v5-omni-small/)). This is backward-compatible
training productised at the vendor's end — the only form of model-change-without-re-embedding that
is reliable today, and one you cannot retrofit (BCT's known tax is that it *"cannot simultaneously
maintain the performance of the new model itself"*, [2108.03372](https://arxiv.org/pdf/2108.03372)).

Neither of our providers offers it, so this buys us nothing now. But it means `spacesCompatible()`
is subtly wrong in the long run: it demands model equality, which would force a migration in
exactly the case where the vendor guarantees none is needed. **Recorded as a one-field extension
(`compatibilityGroup`), deliberately not built (§8).**

### 4.5 Adapters defer the work; they do not remove it — and our case is the pessimistic one

Drift-Adapter ([EMNLP 2025 main](https://aclanthology.org/2025.emnlp-main.805/)) is the only
production-shaped result: learn a map from the new query space into the legacy space and keep the
old index. Measured at 1M items, MiniLM-L6 → MPNet-base, 20k pairs: **0.99 Recall@10 retention**
(MLP), ~0.95-0.97 (orthogonal Procrustes), 3-8 µs added latency, ~0.5 GPU-hours to fit. Then the
caveats, which are decisive for us: **GloVe→MPNet, their drastic-drift stress test, recovers only
0.715**; the adapter **decays 0.99 → 0.83 within 24 h** under 5%/hour corpus churn unless
retrained; a single global adapter degrades on heterogeneous corpora (0.85 vs 0.94 with routed
adapters) — and ours is part code, part prose; 1-5% of queries never recover; and the authors state
it *"defers but doesn't eliminate"* full re-embedding.

bge-m3 is an XLM-RoBERTa encoder with CLS pooling and no instruction prefix. Qwen3-Embedding and
Harrier are decoder LLMs with last-token pooling and instruction-aware queries. That is a change of
backbone family, pooling, and input protocol — architecturally nearer their GloVe→MPNet case than
their MiniLM→MPNet one. **Budget 0.6-0.85 retention, not 0.99.**

vec2vec ([NeurIPS 2025](https://arxiv.org/abs/2505.12540)) is not a migration tool at all — it is
an attack paper whose payoff is *"serious implications for the security of vector databases"*, and
whose metric is top-1 matching on an 8k held-out set, not nDCG on a corpus. No published
corpus-scale retrieval evaluation of translated vectors exists. **That absence is the finding.**

### 4.6 The industry's canonical ordering, and the one mistake everyone makes

Every credible playbook agrees on the ordering, and the near-universal error is the same one:
**arm dual-write BEFORE starting the backfill.** Backfill-then-dual-write leaves the new space
permanently missing every row written during the backfill. Qdrant's migration guide encodes this
explicitly and additionally requires the backfill to be insert-only/update-only so it can never
clobber a fresher dual-write
([Qdrant](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/));
ComplyAdvantage hit the same class of lost-update race and solved it by making dual-write a
property of the *transport* rather than of application code
([ComplyAdvantage](https://technology.complyadvantage.com/beyond-the-_reindex-api-a-blue-green-strategy-for-zero-downtime-elasticsearch/)).
Qdrant's named-vector option — a second vector on the same points, backfilled in place, switched
by a query parameter — is precisely the design in §5, and they document it as the preferred path
*because* "point deletions are safe during this migration."

Qdrant also states the precondition nobody writes down: **"re-embedding requires access to the
original data used to create the embeddings."** We satisfy it for facts, entities, predicates,
episodes, segments and scene gists (the sweep re-embeds from stored text). We do **not** satisfy it
for `lens_suppression.centroid`, which arrives from outside and has no source text at all (D7).

Pinterest's design is the one worth stealing conceptually: their ANN hosts advertise a model
version and the query encoder complies, so a partially-rolled-out fleet is correct by construction
rather than by luck ([Pinterest Engineering](https://medium.com/pinterest-engineering/establishing-a-large-scale-learned-retrieval-system-at-pinterest-eb0eaf7b92c5)).
Our version of that is `activeSpaceFor(tenant)` resolving on the read path — the resolver already
exists (D2); nothing calls it.

---

## 5. The design

**Space is a partition key for storage and migration, and never for a single query's candidate
pool.** Five parts, each reusing something already built.

**5.1 Space identity — unchanged.** `provider:model:dim:norm` (`embedding-space.ts:115`) stays the
canonical id; `EMBEDDING_SPACES` (`:66`) stays the single declaration. One additive field,
`compatibilityGroup`, defaulting to the model id, so a future vendor-compatible pair is expressible
without a migration (§4.4). No new descriptor format.

**5.2 Storage — one vector column per space, sized.** Every vector column becomes
`option<array<float, N>>` with N derived from the declaration (S1). A migration adds a *second*
column, `embeddingNext`, at the target width, plus its own HNSW index. Two columns, two indexes,
two widths, one table (S3) — which is what SurrealDB can express and nothing else is (S4, S13,
S14). The per-row `embeddingSpaceId` stamp (0101) records which space the *active* column holds;
a second stamp `embeddingNextSpaceId` records the target. This is Qdrant's named-vector shape.

**5.3 Serving — one space per query, chosen by the tenant.** The read path resolves
`activeSpaceFor(companyId)` (already written, `embedding-space.service.ts:88`) and selects the
column. This is a new `RetrievalProfile` field of exactly the shape `coverageScanMode` already
has — a per-tenant enum, preset-ineligible by design (`genre-presets.ts:30-34`), threaded through
`PipelineContext.profile`, and folded into the answer-cache key for free by `computeProfileHash`.
No parallel architecture; no lane registry change; the dispatch-lane registry is not involved at
all. **There is never a query that reads both columns.**

**5.4 Degradation — demote the lane, don't fail the request.** When the serving provider is not in
the tenant's active space, the request drops to `mode: 'lexical'` (`search.service.ts:404`) instead
of throwing. `fuse()` already short-circuits correctly (`fusion.ts:68-76`); `scene-lane.service.ts:106`
already documents the equivalent idiom for RRF. The dense-leg `embed()` call gets the inner-try the
three evidence lanes already have (`fragment-lane.service.ts:122-128`). A counter and a
`degraded: true` field on the response make it legible rather than silent. **Write-side stays
fail-closed**, exactly as #503 argued: a cross-space read is transient, a cross-space write is
forever.

**5.5 Retirement — an explicit purge.** `REMOVE FIELD` leaves the data behind (S12), so retiring a
space is `LET $ids = (SELECT VALUE id ... WHERE oldCol != NONE); UPDATE $ids UNSET oldCol;` in
batches, then `REMOVE INDEX`, then `REMOVE FIELD`. Both forget paths must reach the new column, and
the new columns join the two forget table lists (`user-forget.service.ts:87-372`,
`entity-forget.service.ts:239-454`) using the mandatory two-step id idiom — never
`UPDATE ... WHERE` over an indexed field.

**Why not a side table or a per-space table.** Both lose gate push-down: today the retraction /
`asOf` / ABAC / user-scope predicate is pushed *into* the `KnnScan` (S14). Move vectors off the
row and the KNN returns ids that must then be gated in a second pass, so the over-fetch has to
grow to compensate — and over-fetch is exactly what OOM-killed a 16 GB instance
(`scan-leg.ts:74-82`, reproduced in S11). Per-space columns cost a `DEFINE FIELD` per migration;
that is the cheaper trade.

---

## 6. The programme

Ordered. Every item default-off and byte-identical until a flag flips, except E1, which is a bug
fix whose "off" state is broken. No eval forks — every behaviour difference is per-tenant
configuration. Migrations start at **0132** (highest on main is `0131_indexer_run_pack_idx.surql`);
note the collision hazard — `migrationId` is UNIQUE in `schema_migrations`, so if two branches both
ship an `0132_*.surql` one of them **silently never applies** (`migrator.service.ts:51`, `:105-116`).

| # | Item | Migration | Flag family | Blast radius | What proves it |
|---|---|---|---|---|---|
| **E1** | **Fix the missing-index KNN path.** `<\|K,EF\|>` without an index returns unranked rows, not an error (S7), so the documented fall-back-to-scan at `legs.ts:74-79` and `scan-leg.ts:92-109` is dead. Probe for the index (`INFO FOR INDEX`) or detect `knnDist === null` and fall through. Prod runs `SEARCH_HNSW_ENABLED=1` with per-tenant index creation, so this is live. | — | none (bug fix) | Any tenant without an HNSW index — currently served k arbitrary facts with no similarity score | Real-Surreal e2e: query an indexed and an un-indexed tenant, assert the un-indexed one takes the brute path and returns ranked rows |
| **E2** | **Build HNSW `CONCURRENTLY`.** Synchronous `DEFINE INDEX` over 20k × 1024-d **fails** after 133 s (S10); concurrent reaches ready in 4.2 s. Add per-index build (not a 4-index super-statement), poll `INFO FOR INDEX`, surface progress on the admin route. | — | `SEARCH_HNSW_CONCURRENT` | Only the admin maintenance route; the DDL emitted changes, the resulting index does not | `test:e2e:real` — build over ≥20k rows completes and serves; the existing sync path is asserted to fail so the regression is recorded |
| **E3** | **Lexical-carry degraded mode.** Inner-try around `legs.ts:68`; on a space-unavailable embedder, demote `mode` to `'lexical'` and stamp `degraded` on the response + a counter. Replaces both the silent cross-space read (D4) and #504's 503. | — | `SEARCH_DENSE_DEMOTE` | Search + everything downstream of it; off = today's behaviour exactly | Unit: a stub embedder in a foreign space yields lexical-only results, not a throw. `eval:memory-fitness` under a forced-degrade tenant profile, delta published against the −2.4pp expectation from §4.3 |
| **E4** | **Type the width in the substrate.** `DEFINE FIELD OVERWRITE` every vector column to `option<array<float, N>>`, N from `EMBEDDING_SPACES` (S1). **Ordering is load-bearing**: inventory → purge non-conforming rows → tighten. A non-conforming row left behind becomes un-updatable *on every field* (S2). Closes D7 and every future writer at once. | `0132` | none (schema) | Every vector write in the system; a wrong-width write becomes a DB error instead of durable poison | `test/embedding-space-truth.unit-spec.ts` extended to require a sized type on every `VECTOR_COLUMNS` entry; real-Surreal e2e asserting the coercion refusal |
| **E5** | **Corpus inventory + repair route.** Read-only per-tenant census: row counts by vector length, by `embeddingSpaceId`, per each of the 13 columns — length alone cannot detect two models at the same width. Then a repair that UNSETs non-conforming vectors so E4 can land. Prerequisite for E4 and for any migration. | — | `EMBEDDING_SPACE_INVENTORY` | Read-only; the repair is admin-triggered and per-tenant | Route returns a census for a deliberately poisoned fixture tenant; repair makes E4's `DEFINE FIELD` succeed |
| **E6** | **Close the centroid bypass.** `lens_suppression` gets an `embeddingSpaceId` column; the admin ingest requires a declared space and rejects a mismatch. Also add the column to `semantic_belief` (D12). | `0133` | none | The lens-suppression admin route only; existing centroids read as NONE = the active space | Unit: a 1536-wide centroid POSTed to a 1024 tenant is a 400. Both forget paths asserted to reach the new columns |
| **E7** | **Make the sweep complete, resumable, and space-targeted.** Add the four uncovered columns (D12) or explicitly classify them as producer-owned; persist a cursor so a crash resumes; accept a target column so the backfill can write `embeddingNext` instead of overwriting `embedding`; report `failedTenants`/`failedBatches`/partial status. Retire `altEmbedding` and its index (D8). | — | `EMBEDDING_SPACE_DUAL_WRITE` (existing) | The reindex route; default path stays `knowledge_fact.embedding` only | Unit: a sweep interrupted mid-corpus resumes at the cursor. `factsUpdated=0` can no longer report success |
| **E8** | **Second-column dual-write.** `embeddingNext` + `embeddingNextSpaceId` on every sweepable table, plus a concurrent HNSW index per target space. Every write site that calls `embedForWrite` also writes the target vector while `dualWrite` is armed. Qdrant's flagged failure mode — updating one vector and not the other — is the thing to test for. | `0134` | `EMBEDDING_SPACE_DUAL_WRITE` (existing) | Every ingest/compose write path; off = one column written, byte-identical. Storage +8 KB/row/space (S15) | Unit: with dual-write armed, every writer leaves both columns consistent. e2e: a row written mid-migration is present in both spaces |
| **E9** | **Wire the resolver into serving.** `activeSpaceFor(companyId)` → a `RetrievalProfile` field → the column each dense leg reads. 13 cosine sites + 4 KNN sites + the `resolve_fact` DB function (whose cosine dedup gate is copied into 19 migrations — the sharp edge). Makes the cutover at `admin-embedding-space.controller.ts:69-78` mean something (D3). | `0135` (new `resolve_fact` revision) | `EMBEDDING_SPACE_ACTIVE` (existing) | All dense retrieval + ingest dedup; off = the current provider space everywhere, byte-identical | `eval:memory-fitness` + `eval:state-transitions` byte-identical with the flag off; e2e: a cutover flips which column is read, atomically, mid-traffic |
| **E10** | **Retirement + GDPR reach.** Batched `LET $ids → UPDATE $ids UNSET oldCol`, then REMOVE INDEX, then REMOVE FIELD (S12). Both forget lists extended to every new column. | — | `EMBEDDING_SPACE_RETIRE` | Storage reclamation only, post-cutover | e2e: after retirement `SELECT oldCol` returns NONE for every row — not merely a schema absence. Forget e2e asserts both paths clear both columns |

**Not on the critical path:** E1, E2, E3 are independent bug fixes and should ship first regardless
of whether anything else does. E4-E6 are the substrate invariant. E7-E10 are the migration
machinery and are only worth building when a model change is actually scheduled (§8).

---

## 7. The zero-downtime model migration, end to end

What an operator actually runs, once E4-E10 exist. Per tenant. Steps 2 and 3 are the ones people
invert (§4.6).

```
# 0. PRECONDITION — source text must be recoverable for every vector.
#    Facts/entities/predicates/episodes/segments/gists: yes (the sweep re-embeds from stored text).
#    lens_suppression.centroid: NO — it is externally supplied. Re-fit it, don't migrate it.

# 1. CENSUS — refuse to start on a dirty corpus.
GET  /v1/admin/embedding-space/inventory?tenant=T
#    → per-column row counts by vector length and by embeddingSpaceId.
#    Any non-conforming row must be repaired before anything else (S2).

# 2. BEGIN — arm dual-write FIRST. This creates embeddingNext + its concurrent index.
POST /v1/admin/embedding-space/begin  {tenant:T, targetSpace:"<provider:model:dim:norm>"}
#    → phase=dual_write. New writes now land in BOTH columns. Reads are unchanged.
#    Watch INFO FOR INDEX until the (empty) target index reports ready.

# 3. BACKFILL — only now. Resumable, rate-limited, insert-only into the target column.
POST /v1/admin/reindex/embeddings?tenant=T&allTables=true&target=next&dryRun=true
POST /v1/admin/reindex/embeddings?tenant=T&allTables=true&target=next
#    → the sweep never touches the active column. Serving is untouched throughout.
#    Budget from S10: ~4 700 rows/s to index; embedding throughput dominates
#    (~10 GPU-hours per 10M short chunks self-hosted; ~$0.02/M tokens on the API path).

# 4. SHADOW — measure before flipping. Never fuse; query each space separately.
POST /v1/admin/embedding-space/shadow  {tenant:T, queries:<golden set>}
#    → recall@k / nDCG@k for active vs target, per query class.
#    Gate: target ≥ active within the published tolerance. Set the threshold BEFORE looking.

# 5. CUTOVER — atomic, per tenant, all-or-nothing.
POST /v1/admin/embedding-space/cutover {tenant:T, targetSpace:"<...>"}
#    → single UPSERT: activeSpace=target, targetSpace=NONE, dualWrite=false, phase=cut_over.
#    Reads switch wholly to the new column. There is never a half-migrated query.

# 6. ROLLBACK — for as long as the old column exists, this is a one-statement flip back.
POST /v1/admin/embedding-space/cutover {tenant:T, targetSpace:"<the old space id>"}
#    Nothing was destroyed in steps 2-5, which is the entire point of the second column.
#    (During step 3 only: abort is POST /v1/admin/embedding-space/abort — the target column
#     is partial and unread, so abandoning it costs storage and nothing else.)

# 7. RETIRE — only after the rollback window closes.
POST /v1/admin/embedding-space/retire {tenant:T, space:"<the old space id>"}
#    → batched LET $ids → UPDATE $ids UNSET; then REMOVE INDEX; then REMOVE FIELD.
#    REMOVE FIELD alone does NOT delete the data (S12).
```

The rollback story is what makes this zero-downtime rather than merely online: at every step
before 7, the previous space is intact and reachable by flipping one field. That is not true of
today's sweep, which overwrites the only copy in place (D9).

---

## 8. Deliberately not doing, and why

- **Multi-space live serving.** The union of two spaces is not a quality play: the one direct
  measurement finds small, pair-dependent, sometimes-negative gains and says a strong+weak pair is
  pointless ([WOWS 2025](https://ceur-ws.org/Vol-4137/WOWS_2025_paper_4.pdf)); a cross-encoder on
  one retriever buys more, reliably ([2212.06121](https://arxiv.org/abs/2212.06121)). Our fact-level
  fusion is convex *by measurement* (`fusion.ts:19-29`) and cosine magnitudes are not comparable
  across models, so we could not fuse them even if we wanted to. And SurrealDB cannot OR two KNN
  operators (S13), so it would cost a second round trip per query for the privilege.
- **Cost/latency tiers as separate live spaces.** Same argument, plus a cheaper one: HNSW `TYPE I8`
  (S16) gives a quantised *index* over the *same* space, and Ada's production bakeoff measured int8
  costing 0.1pp recall ([Ada](https://www.ada.cx/labs/research/vector-database-migration/)). A
  latency tier is an index parameter, not a space.
- **Per-modality spaces.** Already designed and parked in
  [multi-vector-2026-08.md](multi-vector-2026-08.md) for its own reasons (no producer, no consumer,
  measurement frozen). This design's per-space column is exactly the storage that unblocks it when
  it lands; nothing here pre-empts it.
- **Embedding-space adapters (Drift-Adapter class).** Real, peer-reviewed, and wrong for us: our
  jump changes backbone family, pooling and input protocol, which is their drastic-drift case
  (0.715, not 0.99); the adapter decays 0.99 → 0.83 in 24 h under churn; a single global adapter
  degrades on a mixed code+prose corpus; and the authors say it defers rather than eliminates the
  re-embed. It is a bridge for a forced API deprecation, which is not the situation we are in.
  Cheap to revisit — an orthogonal-Procrustes fit is one SVD — so it is recorded, not refuted.
- **vec2vec / unsupervised space translation.** Research-only for this purpose; it is an attack
  paper measuring top-1 matching on 8k held-out items, and no corpus-scale retrieval evaluation of
  translated vectors exists. Worth knowing for the opposite reason: it is evidence that stored
  vectors leak the content of the text they encode, which is a GDPR question we have not asked.
- **MRL / truncatable dimensions as a requirement.** §4.1. bge-m3 is not MRL, MRL does not make
  cross-model comparison safe, it costs 0.02-0.03 nDCG at full width, and PCA truncates
  competitively. It is an ops convenience on the successor and nothing more.
- **bge-m3's ColBERT head.** Its token vectors are 1024-d (ColBERT's are 128-d) with no published
  compression scheme, against ColBERTv2's 36 bytes/token at 2-bit residual
  ([2112.01488](https://arxiv.org/pdf/2112.01488)). It buys +1.2 nDCG on MIRACL and +0.2 on MKQA
  ([2402.03216](https://arxiv.org/html/2402.03216v3)). The *sparse* head is the valuable one
  (+9.7 nDCG on long documents) and belongs to the lexical roadmap, not this one.
- **A side table or per-space table for vectors.** Loses gate push-down into the `KnnScan` (S14),
  which forces the over-fetch up, which is the exact query shape that OOM-kills the database (S11).
- **Index aliases for the swap.** SurrealDB has no alias primitive, and two indexes on one field
  leave the planner picking one unspecified (S5). The swap is a column choice on the read path,
  which is better anyway because it is per-tenant rather than global.
- **Changing the fusion doctrine.** The literature agrees convex beats RRF by ~2-3 nDCG when you
  have labels to tune with ([TOIS 2023](https://arxiv.org/abs/2210.11934)), which is what
  `fusion.ts` already measured for itself. The two doctrines in this repo (convex for facts, RRF
  for lanes) are a real inconsistency, but it is not this document's inconsistency to fix.

---

## 9. Honest caveats

- **All SurrealDB numbers in §3 are from a single scratch container** (8 GB, rocksdb, synthetic
  random unit vectors, 20k rows). They establish *behaviour* reliably — a parse error, a coercion
  refusal, an OOM kill, a 133 s failure vs a 4.2 s success — and *throughput* only
  order-of-magnitude. S10 in particular should be re-run on production-shaped hardware before it
  is quoted as a capacity number, though the failure itself reproduced twice.
- **The KNN query latencies measured alongside S10 are not reported** — the instance was already
  under memory pressure from the failed synchronous builds, so the numbers are not trustworthy.
- **No retrieval-quality claim here has been measured on our corpus.** §4.3's −2.4pp is MemPro's
  LoCoMo number, not ours; E3 must publish its own delta from `eval:memory-fitness` before the flag
  earns a default.
- **MTEB/MMTEB rankings are contaminated and unstable** — models train on MTEB splits, graded
  relevance reshuffles binary-label ordering, and the top cluster sits within 1-2 points
  ([MMTEB](https://arxiv.org/html/2502.13595v4)). The §1 claim that Qwen3-0.6B ≈ bge-m3 on
  retrieval is a leaderboard claim and should be re-measured on our corpus before it decides
  anything. That is itself an argument for the shadow step in §7.
- **#504 is open and overlaps.** It flips `EMBEDDING_SPACE_STRICT` default-on and propagates the
  reindex 503. E3 supersedes the read-side half of that (demote rather than 503); the write-side
  half and the readiness fixes stand. Sequence E3 after #504 merges, not against it.
- **The `resolve_fact` DB function is copied into 19 migrations** and carries a cosine dedup gate.
  E9 must ship a new revision of it; editing a shipped migration is invisible in prod
  (`CONTRIBUTING.md:69-83`).
- **Evidence quality varies.** The engineering literature on real re-embedding migrations is thin
  and heavily colonised by content farms; the figures used here are limited to peer-reviewed
  papers, vendor primary docs, and first-party engineering blogs. No dollar-per-migration estimate
  in circulation traces to a verifiable source, so §7 gives throughput and unit price and leaves
  the arithmetic to the operator.

**One-line takeaway:** the space is already named, already guarded at the process boundary, and
already has a cutover statement — but it is not *stored*, so the migration protocol the codebase
documents cannot be executed and the failover it ships answers from the wrong coordinate system;
give each space its own typed column, let the tenant's active space choose which one is read, let
the lexical lane carry the query when no space is available, and a model change becomes a
per-tenant flip with a one-statement rollback instead of a rebuild with an outage.
