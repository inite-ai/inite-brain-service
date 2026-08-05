# LongMemEval-S State of the Art (2025–2026)

Research agent output, 2026-08-03. Context: our LME-500 final is 50.2%
judged (gpt-4o-mini reader, ~4.7K tokens/q), temporal 24.4 / MS 51.2 /
KU 63.9 / SSA 55.4 / SSU 82.8 / SSP 43.3.

**Comparability warning:** there is no neutral leaderboard. Every number
below is self-reported unless it comes from a peer-reviewed paper's own
harness, and judges differ (gpt-4o, gpt-4o-mini, GPT-OSS-120B, GPT-4.1,
Gemini 3 Flash). The only controlled same-harness comparisons are
SmartSearch's Table 7 (uniform gpt-4.1-mini reader) and Memoria's
frozen-retrieval reader sweep.

## 1. Leaderboard

| System | Overall | Reader (answer model) | Judge | Tokens/q | SSU | SSA | SSP | MS | TR | KU | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **MemCog** ([arXiv 2605.28046](https://arxiv.org/html/2605.28046v1)) | **95.8** | GPT-4o (agentic navigation) | — | "modest" | 100 | 98.2 | 96.7 | **92.5** | 98.5 | 91.0 | paper |
| **OMEGA** ([omegamax.co/benchmarks](https://omegamax.co/benchmarks)) | 95.4 | GPT-4.1 | GPT-4.1 | — | 99 (SS recall) | — | 100 | 83 | 94 | 96 | self-reported |
| **Mastra Observational Memory** ([mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory)) | 94.87 | gpt-5-mini (ingest: gemini-2.5-flash) | gpt-4o | ~30K in-context | 95.7 | 94.6 | 100 | 87.2 | 95.5 | 96.2 | self-reported |
| **Mem0** (Apr 2026 algo, [blog](https://mem0.ai/blog/state-of-ai-agent-memory-2026), [research](https://mem0.ai/research)) | 94.4 | undisclosed | gpt-4o | ~6,787 | 98.6 | 98.2 | — | 88.0 | — | 93.6 | self-reported |
| **ByteRover** ([blog, Jul 2026](https://www.byterover.dev/blog/benchmark_ai_agent_memory_real_production_byterover_top_market_accuracy_longmemeval)) | 92.8 | Gemini 3 Flash + Gemini 3.1 Pro justifier | Gemini 3 Flash | — | 98.6 | 98.2 | 96.7 | 84.2 | 91.7 | 98.7 | self-reported |
| **Hindsight** ([arXiv 2512.12818](https://arxiv.org/html/2512.12818v1)) | 91.4 / 89.0 / 83.6 | Gemini-3 Pro / GPT-OSS-120B / OSS-20B | GPT-OSS-120B | — | 97.1 | 96.4 | 80.0 | 87.2 | 91.0 | 94.9 | paper (Gemini-3 col.) |
| **Memoria** (MatrixOrigin, [Medium](https://medium.com/@matrixorigin-database/benchmarking-memoria-on-longmemeval-strong-memory-retrieval-clear-reader-separation-ee6c89c75d76)) | 88.78 | gpt-5.4 (best of 3 readers) | gpt-5.4 | 10 memories/q | 95.7–100 | 100 (all readers) | — | 79.0 | 90.2 | 89.6 | self-reported |
| **SmartSearch index-free** ([arXiv 2603.15599](https://arxiv.org/html/2603.15599v1)) | 88.4 | **gpt-4.1-mini** | gpt-4o-mini | 3,392 | 100 | 85.7 | 96.7 | 84.2 | 82.7 | 93.6 | paper |
| Memora (same harness) | 87.4 | gpt-4.1-mini | gpt-4o-mini | ~2,900 | 98.6 | 78.6 | 83.3 | 78.2 | 89.5 | 97.4 | paper (SmartSearch T7) |
| **Emergence AI** ([blog](https://www.emergence.ai/blog/sota-on-longmemeval-with-rag)) | 86.0 | GPT-4o-2024-08-06 | — | — | 98.6 | **100** | 60.0 | 81.2 | 85.7 | 83.3 | self-reported (Jul 2025) |
| **Supermemory** ([research](https://supermemory.ai/research/longmembench/)) | 85.2 / 84.6 / 81.6 (~85.9 new engine) | gemini-3-pro / gpt-5 / gpt-4o | gpt-4o (paper prompts) | ~720 retrieved | — | 100* | 90* | 93* | 91* | 99* | self-reported (*Recall@15, not accuracy) |
| EverMemOS / MemOS / Nemori | 83.0 / 77.8 / 74.6 | gpt-4.1-mini | gpt-4o-mini | 2,800 / 1,400 / 4,300 | — | 85.7 / 67.9 / 92.9 | — | 73.7 / 70.7 / 55.6 | 77.4 / 77.4 / 72.2 | — | paper (SmartSearch T7) |
| **Zep/Graphiti** ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956), [blog](https://blog.getzep.com/state-of-the-art-agent-memory/)) | 71.2 (gpt-4o) / 63.8 (4o-mini) | gpt-4o / gpt-4o-mini | LLM judge | ~1,600 | 92.9 | 80.4 / 75.0 | 56.7 / 53.3 | 57.9 / 47.4 | 62.4 / 54.1 | 83.3 / 74.4 | paper |
| Mem0 (old, reproduced) | 66.4 | gpt-4.1-mini | gpt-4o-mini | 1,100 | 82.9 | **26.8** | 90.0 | 63.2 | 72.2 | 66.7 | paper (SmartSearch T7) |
| Full-context baseline | 65.6 (4.1-mini) / 60.6 (4o, orig. paper) | gpt-4.1-mini / gpt-4o | — | ~115K | 85.7 | 98.2 | 16.7 | 51.1 | 60.2 | 76.9 | paper |
| Oracle (evidence-only sessions, GPT-4o) | 82.4–87.0 | gpt-4o | — | — | — | — | — | — | — | — | orig. paper ([2410.10813](https://arxiv.org/abs/2410.10813)) |

**Not on the board:** Letta — no published LME numbers
([issue #3115](https://github.com/letta-ai/letta/issues/3115)).
**SimpleMem** ([arXiv 2601.02553](https://arxiv.org/abs/2601.02553))
claims LME-S wins but its extractable tables are LoCoMo-only.
**MemIR** ([arXiv 2605.25869](https://arxiv.org/html/2605.25869v1)) is
evaluated on LoCoMo/BEAM-100K only, not LME-S.

**Original-paper technique deltas**
([2410.10813](https://arxiv.org/abs/2410.10813)): round-granularity >
session; fact-expanded index keys +5% accuracy; time-aware indexing
+7–11% temporal recall; Chain-of-Note + JSON reading +10 abs. points.

## 2. Mechanisms for our three weakest types

### a. Temporal reasoning (ours: 24.4%)

Everyone above 55% does **absolute-date normalization at write time +
timestamp rendering into the reader prompt**:

- **SimpleMem:** relative expressions ("next Friday") converted to
  absolute ISO-8601 timestamps at memory construction time.
- **Mastra (95.5 TR):** every observation carries up to three dates —
  observation date (when created), referenced date (mentioned in
  content), relative date (computed offset).
- **Supermemory:** dual timestamps — documentDate (when said) vs
  eventDate (when it happened).
- **Hindsight (79.7–91.0 TR):** facts carry (τs, τe, τm) = occurrence
  interval + mention time; retrieval prioritizes memories whose
  occurrence interval overlaps the query range; temporal links with
  exponential distance decay.
- **Zep (54.1–62.4 TR):** bi-temporal KG, valid_at/invalid_at edges.
- **Key counterpoint — SmartSearch (82.7 TR with a mini reader):** no
  temporal index at all — plain session timestamps on verbatim
  passages plus a good reranker. Their indexed variant added only
  +3.8pp TR. So for a mini-class reader, rendering clean absolute
  dates on every retrieved chunk is most of the win; special temporal
  indexes are second-order.

### b. Multi-session (ours: 51.2%)

MS is the weakest category even at the top (OMEGA 83, ByteRover 84.2,
Mastra 87.2) — cross-session aggregation/counting is the field's
residual failure mode. What the leaders do:

- **MemCog (92.5 MS, best published):** agentic multi-step retrieval —
  the agent autonomously determines the next action at each step,
  typically 2–3 steps/query.
- **Emergence (81.2 MS):** retrieve **whole sessions**, not turns —
  match on turns, retrieve entire sessions scored by NDCG of their
  turns after cross-encoder reranking, plus forced chain-of-thought.
  (Independent review notes fixed k=42:
  [Medium/Calvin Ku](https://medium.com/asymptotic-spaghetti-integration/emergence-ai-broke-the-agent-memory-benchmark-i-tried-to-break-their-code-23b9751ded97).)
- **SmartSearch (84.2 MS):** rule-based NER entity discovery on
  retrieved passages to expand the query; explicit multi-hop needed
  for only ~3% of queries.
- **Hindsight (87.2 MS):** graph traversal across sessions via entity,
  temporal, semantic, and causal links.
- **Mastra (87.2 MS):** sidesteps retrieval — the whole compressed
  observation log (~30K tokens, all ~50 sessions) is always in
  context, so aggregation is a pure reading task.

### c. Single-session-assistant (ours: 55.4%)

The clearest signal in the whole dataset: **user-fact extraction
pipelines destroy SSA; verbatim conversational storage fixes it.**

- Full-context gets **98.2 SSA**; old Mem0 (extraction-based) got
  **26.8** in the same harness; Zep scores *below* its own
  full-context baseline on SSA — fact extraction drops assistant-side
  content.
- Systems at 98–100 SSA store assistant turns verbatim or chunked:
  Emergence (session-level retrieval, 100), Supermemory (chunks +
  atomic memories, 100), Memoria (100 across all three readers),
  Mem0's April-2026 rewrite (26.8 → 98.2 — they evidently fixed
  exactly this).
- **MemIR** names the failure mode "provenance-role collapse" and
  fixes it with typed, source-grounded atoms where every claim retains
  an explicit evidential origin — but is not LME-evaluated.
- Actionable: index assistant utterances verbatim (role-tagged), don't
  route them through user-fact extraction.

## 3. Abstention (ours: 23.3%)

- The 30 `_abs` questions are false-premise rewrites; the official
  repo skips them in retrieval eval. Most self-reports quietly exclude
  or don't break them out (SmartSearch explicitly evaluates 6 of 7
  types excluding abstention; Mastra and MemCog report none).
- **Best published abstention-subset numbers — Memoria, retrieval
  frozen across readers:** claude-opus-4.6 **93.33%**,
  claude-sonnet-4.5 86.67%, gpt-5.4 **56.67%** (only emitted "I don't
  know" 3 times vs Sonnet's 79). With identical retrieval, abstention
  is almost entirely a reader-calibration property.
- Supermemory's lever is prompt-side: respond "I don't know" or
  explain what is missing when context is insufficient. Our 23.3%
  likely has large headroom from an explicit answer-prompt abstention
  instruction alone, at some cost to always-answer types.

## 4. Answer-model (reader) sensitivity — same memory, different reader

- **Memoria** (frozen retrieval, 3 readers, single judge):
  knowledge-update spread **58.44% → 89.61% (31pp)**; abstention
  56.67 → 93.33 (36.7pp).
- **Mastra:** identical ingestion, actor swap: gpt-4o 84.23 →
  gemini-3-pro 93.27 → gpt-5-mini 94.87 = **+10.6pp** reader-only.
- **Hindsight:** OSS-20B 83.6 → OSS-120B 89.0 → Gemini-3 91.4 =
  **+7.8pp**.
- **Zep:** gpt-4o-mini 63.8 → gpt-4o 71.2 = **+7.4pp** (TR +8.3,
  MS +10.5); full-context alone: TR 36.5 → 45.1, SSA 81.8 → 94.6.
- **Supermemory:** gpt-4o 81.6 → gemini-3-pro 85.2 = +3.6pp.

**Calibration for our 50.2% @ gpt-4o-mini, ~4.7K tokens:** the fairest
comparisons are Zep at 63.8 (same reader class) and SmartSearch at
**88.4 with gpt-4.1-mini and 3.4K tokens** — proof that a mini-class
reader on a comparable token budget can reach high-80s with verbatim
passages + strong reranking (mxbai-rerank-large cross-encoder +
ColBERT RRF) + entity-expansion, no graph structure. Expect roughly
+7–10pp from a reader upgrade alone, concentrated in temporal, SSA,
and abstention; the rest of the gap to 88+ is retrieval quality and
date rendering, not reader.
