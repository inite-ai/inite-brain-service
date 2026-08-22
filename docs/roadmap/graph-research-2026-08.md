# Graph usage research (2026-08-15)

Question from the owner: "we barely use the graph at all — how do other
players solve this?" Three parallel sweeps: a file:line inventory of our
own graph surface, a mechanism-level review of Zep/Graphiti + HippoRAG,
and a review of the Mem0^g / GraphRAG / LightRAG class plus the honest
negative-result literature. Prior in-repo research this builds on:
`memory-rebuild-2026-07.md` §5 (the 2026-07-26 three-tier verdict) and
`lme-sota-research-2026-08.md`.

## 1. Our own graph surface: written, not read — and absent from evals

Full inventory (agent sweep, file:line refs verified):

**Default-on graph usage in the read path is exactly three things:**
1-hop edge expansion from the top-3 seeds (α=0.4 inherited score,
`search/internals/edge-expansion.ts`), neighbour names+kinds as free
text in the LLM rerank prompt (`internals/neighbours.ts` — the ONLY
place edge `kind` reaches any scoring decision), and `mergedInto`
re-attribution. Everything else is off, unwired, or absent.

**The flagship evals run on an edge-free graph.** The BEAM/LME recipe
sets `INGEST_EPISODE_ONLY=1` → extraction is skipped → no entities, no
edges; the deriver's JSON schema has no `edges` key and the derive path
imports no edge writer. So edge expansion, rerank neighbours, PPR, and
communities all structurally NO-OP on every eval world we have ever
measured. Our eval numbers say nothing about our graph — for or
against. (LoCoMo is the exception: it ingests via `/v1/ingest/mention`
with extraction on, so edges exist there.)

**Complete but dormant:** PPR (`internals/ppr.ts`, textbook α=0.85,
default OFF — measured pathological on small tenant graphs);
communities (a faithful graphiti label-propagation port with REST + MCP
read surface — zero retrieval callers; the "type hint into the listwise
reranker" promised in `community.service.ts:84` and `0036_communities.surql:59`
was never implemented); `graph_retrieve` entity-anchored lane (called
only by the MCP tool and the admin demo chat); multi-hop edge expansion
(flag off).

**Write-only / rotting fields:** `knowledge_edge.invalidatedAt` has NO
writer anywhere (edge_invalidated_idx indexes a permanently-NONE
column). [Update 2026-08-22: still no writer, but no longer
reader-free — the edge fence (`search/internals/edge-fence.ts`) now
gates every fenced edge read on `invalidatedAt IS NONE`, the community
builder filters on it, and the entity relations read filters AND
projects it. Field + index therefore kept in the 0090 dead-native
cleanup; the actionable gap remains the missing writer.]
`weight` is hardcoded 1.0 on every automatic path; per-edge
extraction confidence is stored into `source` and never read; edge
`kind` is a free vocabulary with no registry (works_at vs employed_by =
two distinct edges forever — contrast the fact-predicate registry);
edges are not bitemporal (no validFrom/validUntil) while facts are.

**Hot-path hygiene gaps:** none of the four retrieval-path edge queries
(`edge-expansion.ts`, `neighbours.ts` ×2, `ppr.ts`, `graph-retrieve-db.ts`)
filter `invalidatedAt` OR `userId` — the user-scope fence every fact
read has (0055) does not exist on edge reads. Related to audit item 10
(policy-aware evidence context).

**Config-catalog lies:** `SEARCH_PPR_ENABLED` and
`MULTI_HOP_EDGE_EXPANSION_ENABLED` are catalogued with
`defaultValue: '1'` while the code default is FALSE (and .env.example /
operations.md agree with the code). Three `COMMUNITIES_*` knobs are
read by code but absent from the catalog entirely.

## 2. External evidence: what graph structure actually buys (2024-2026)

### The only mechanism with a load-bearing ablation: PPR (HippoRAG)

HippoRAG 1 (NeurIPS'24): Personalized PageRank seeded on query
entities over a phrase graph; removing PPR drops 2Wiki R@5 89.1→61.4.
HippoRAG 2 (ICML'25): passage nodes IN the graph, query→triple linking,
PPR ranks passages — ablations show the biggest lever is the query→
graph LINKING quality (query→node instead of query→triple collapses
recall 87.1→59.6), passage nodes are worth +6.1. The wins concentrate
where the answer chain is spread across documents (2Wiki +21pp); on
HotpotQA the graph is ≤ a dense retriever. In MemoryAgentBench,
HippoRAG-2 is the best accurate-retrieval system (65.1% vs BM25 60.5)
— the ONE graph system that beats plain baselines on a neutral stand.

### Zep/Graphiti: mostly hybrid search over graph-artifact TEXT

The default Graphiti read path is cosine+BM25+RRF/MMR over edge-fact
text and node names — plain hybrid search. The graph-native legs (BFS
from recent episodes, node-distance rerank, episode-mentions rerank)
are optional recipes; BFS ships only in the cross-encoder configs. No
published ablation isolates the traversal contribution. Zep's LME win
over full-context (71.2 vs 60.2) is honestly read as extraction +
bitemporal edge invalidation + compact context, not traversal. Their
LoCoMo number varies 84 / 75.1 / 58.4 / 42.3 / 37.5 across five stands
(own blog → own re-run → Mem0's run → ENGRAM → MemoryAgentBench).

### The convergent negative result for conversational memory

Four independent 2025-26 stands agree that in conversational memory,
graph systems do NOT beat simple typed/dense/BM25 designs:

- **Mem0's own paper**: Mem0^g (graph) LOSES single-hop (−1.4) and
  multi-hop (−4.0) to flat Mem0; wins only temporal +2.6 / open-domain
  +2.8; total +1.56 overall at 3× search latency and 2× tokens.
- **ENGRAM** (arXiv:2511.12960): typed dense-only (3 stores, top-k, no
  graph) beats Zep/Mem0/memOS/full-context on LoCoMo (77.6) and LME-S
  (71.4 vs 56.2 FC) at ~1% of tokens; temporal 70.8 with no graph.
- **MemoryAgentBench** (arXiv:2507.05257): commercial graph systems
  (Mem0 32.6, Cognee 28.3, Zep 37.5) lose to plain BM25 (60.5) on
  accurate retrieval.
- **AgentMemBench** (arXiv:2608.00009): entity-graph memory is the
  WORST memory shape tested (macro recall 0.361 vs 0.792 dense);
  verdict "avoid GEM for retrieval".
- **Letta**: filesystem memory 74.0 LoCoMo > Mem0^g 68.5 — "the
  harness, not the memory tool".

**Judge-protocol caveat cutting both ways:** the only debiased
GraphRAG study (arXiv:2506.06331) found position/length biases produce
>30-50pp win-rate swings and REVERSED LightRAG-vs-NaiveRAG on
Agriculture (66.7% → ~39%). Treat any graph-vs-flat delta under ~10pp
on LLM-judge protocols as harness noise.

### Where graphs DO robustly pay

1. **Offline aggregation for sensemaking/summary questions** —
   GraphRAG community summaries / LightRAG high-level lane win even in
   the systematic comparison (arXiv:2502.11371) and GraphRAG-Bench.
   The mechanism that pays is the offline AGGREGATION, not read-time
   traversal. (Note: this is the corpus-QA analogue of what our digest
   leg already does per-conversation — measured +5.0 strict in §6.)
2. **Multi-hop corpus QA** — real but small (~3pp) and method-fragile.
3. **Temporal metadata on relations** — Zep's bitemporal edges and
   Mem0^g's dated triples move temporal rows, but ENGRAM reproduces
   the same temporal wins with typed records + temporal anchors, no
   graph. It's the METADATA, not the graph. (We already have
   bitemporal facts + mentionedAt + overlap_boost.)

## 3. Verdict

The July three-tier verdict survives contact with the 2026 literature,
strengthened: **the graph is not a retrieval lever for our task class.**
Our weak rows (summarization / temporal / ordering nugget; LME TR/MS)
are being addressed by the mechanisms the evidence actually supports —
digest (offline aggregation, built, +5.0 strict), mentionedAt temporal
metadata (built), date rendering, nugget-primary measurement. The
"мы не используем граф" observation is TRUE but is not the gap: the
players who lean hardest on graphs (Zep, Mem0^g, Cognee) lose neutral
stands to typed-dense baselines, and the one genuinely load-bearing
graph mechanism (HippoRAG PPR) pays on corpus KB-QA, not
conversational memory — and requires the edges we don't write on eval
worlds anyway.

## 4. Ranked actions

1. **Hygiene, quota-free (build now):** fix the two config-catalog
   default lies (PPR, multi-hop expansion); catalog the three
   `COMMUNITIES_*` knobs; add the `userId`/`invalidatedAt` fence to the
   four hot-path edge queries (audit item 10 adjacency — a fenced
   user's edges currently leak into edge expansion for other users of
   the same tenant).
2. **The owed ablation, cheap (LoCoMo axis, where edges exist):**
   edge-expansion ON (current default) vs α=0 — external prior
   predicts null-to-negative; if confirmed, flip the default off and
   the read path loses its last silent graph dependency; if positive,
   we finally have one measured graph win. Closes the
   memory-rebuild §5 debt.
3. **Communities decision:** the port is complete, tested, and
   unreachable from retrieval. Either (a) wire the summaries as an
   offline-aggregation evidence source for the summary lane (the one
   externally-supported graph pattern — but our digest already
   occupies this slot; measure only if digest gate-shaping stalls), or
   (b) leave as the MCP/REST agent surface it already is and stop
   carrying the "reranker type hint" promise in comments. Do NOT build
   community-QA for factoid rows (zero positive ablations).
4. **Deriver edges: only behind a measured need.** Teaching the derive
   path to write edges is a prerequisite for ANY graph leg on the
   flagship axes — and per the external evidence the expected payoff
   is null for conversational QA. Park unless a specific lane (e.g. a
   future HippoRAG-shaped entity-join reranker over segments) earns a
   leg on LoCoMo first.
5. **Do not build:** read-time traversal legs, edge taxonomy/registry
   for retrieval, edge embeddings, community hierarchies, node-distance
   reranking — no external evidence survives the debiased protocols.

Sources: arXiv 2501.13956, 2405.14831, 2502.14802, 2504.19413,
2511.12960, 2507.05257, 2608.00009, 2506.06331, 2502.11371,
2506.05690, 2404.16130, 2410.05779, 2510.27246, 2507.03724,
2502.12110; getzep/graphiti search{,_utils,_config_recipes}.py; Zep
and Letta engineering blogs; Cognee/Memobase/Supermemory self-runs.

## 5. Ablation executed (same day): edge expansion = measured NULL, default flipped OFF

The action-1 build wave (edge fence + catalog truth) shipped in
`c6b4917`; the action-2 ablation ran on LoCoMo dev-5 — the ONE eval
axis whose worlds carry edges (locow8/wd-v2: 255 edges over 1238
entities) — with the V10 guard env, judge gpt-4.1-mini, paired by
questionId.

**Bug caught by the ablation itself:** the documented kill switch
(`SEARCH_EDGE_EXPANSION_ALPHA=0`) had NEVER been reachable — the
parser's `rawAlpha > 0` guard silently mapped an explicit 0 back to
0.4, so the first "arm B" ran byte-identical to its baseline. That
invalid pair became a same-config replication measurement: headline
reproduces to 0.0pp with 17/17 flips on n=762 — the axis's noise
floor. Parser fixed (0 is now valid) and alpha ≤ 0 now returns BEFORE
the two graph round-trips instead of after them.

**The real pair (fixed kill switch):**

| | edge expansion ON (α=0.4) | OFF (α=0) | Δ | p (McNemar) |
|---|---|---|---|---|
| headline judge (n=762) | 75.3% | 74.8% | −0.5pp | 0.61 |
| multi-hop (n=142) | 60.6% | 57.7% | −2.8pp | 0.29 |
| temporal (n=156) | 75.0% | 75.6% | +0.6pp | 1.0 |
| open-domain (n=46) | 37.0% | 39.1% | +2.2pp | 1.0 |
| single-hop (n=418) | 84.7% | 84.2% | −0.5pp | 0.75 |

NULL across the board — every row inside the measured replication
noise envelope; the multi-hop lean (8 flips total) is well inside the
±4pp/ability band. Matches the external prior (Mem0^g's own multi-hop
LOSS; AgentMemBench "avoid GEM for retrieval").

**Decision (per the §4 pre-commitment):** default flipped to
`SEARCH_EDGE_EXPANSION_ALPHA=0` — the default search path stops paying
two graph round-trips per request for a measured-null mechanism. The
knob stays runtime-tunable per tenant (0.4 = historical behavior); the
guard band for future LoCoMo runs moves to the OFF arm (74.8).

**Residual not covered by this ablation:** the rerank neighbour
injection (B2 — `Connected to:` lines in the LLM rerank prompt) is a
separate mechanism that rides the reranker, not alpha; it remains
default-on-when-reranker-configured and unmeasured in isolation.
