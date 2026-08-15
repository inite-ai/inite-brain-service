# Brain — LoCoMo / QA architecture optimization roadmap

Synthesis of 4 deep-research legs (SOTA memory architectures, retrieval-pipeline optimizations, memory-tier patterns, internal pipeline audit). Current: cat1-4 LLM-judge **24.3%** (1 sample, HTTP retrieve+synthesize path).

## The reframe (what all four legs converge on)

**24% is NOT primarily a retrieval-sophistication problem.** Brain already has more retrieval machinery than most published systems: query decomposition (multi-hop planner), query expansion, hybrid vector+BM25 fusion, cross-encoder + RankGPT reranker, PPR + label-propagation communities, dedup/compaction/decay/supersede, grounded synthesis with verifier + conformal guardrail. The gap is elsewhere:

1. **Measurement/answer-contract** — competitors' answerers ALWAYS emit a short concrete answer and NEVER abstain; the standard LoCoMo LLM-judge is deliberately *generous* (topical match) and *punishes abstention*. Brain's synthesize abstains (`no_grounded_evidence`) → guaranteed 0 on answerable questions. Even weak single-shot systems score ~60-67% J; our 24% smells of the answer-contract + possibly a stricter judge than the convention.
2. **Facts lose their context at storage time** — we embed bare `predicate: object` ("likes: hiking"), stripped of who/when/topic. This is the single biggest *genuine* retrieval gap.
3. **Chatter and time are under-managed** — no importance/salience signal (all facts equal minus decay); temporal is a WHERE-filter and `validFrom` = message timestamp, not the in-text event date.
4. **Everything is single-pass** — no retrieve→reason→retrieve loop; consolidation layers (communities/summaries) are built off-hours but never read at query time.

**Honest ceiling ≈ 85%** (MIRIX, agentic, GPT-4.1-judge), NOT 94%. The 90%+ numbers are judge-inflation + dropped adversarial category + a benchmark whose answer key is ~6.4% wrong (theoretical ceiling 93.6%). Synthius' 94.37% is self-reported, unreplicated. Target the honest agentic ~85%, not the leaderboard.

## Prioritized roadmap (impact / effort)

### Tier 0 — Measurement & answer contract (do first; ~free, decisive)
- **Never-abstain answering mode for the benchmark.** For answerable categories the synthesizer must always emit its best short answer from retrieved facts instead of `no_grounded_evidence`. Add a `guardrails: 'answer'` / best-effort mode. Files: `src/synthesize/synthesize.service.ts` (the abstention/verifier fail-closed path), `test/eval/locomo/http-agent.ts` (already uses `lenient`; needs a stronger never-abstain).
- **Verify judge generosity** vs the Mem0/community convention (topical/factual match, numbers/dates by meaning). Files: `test/eval/locomo/judge.ts` (`LOCOMO_JUDGE_SYSTEM`).
- **Per-category J error analysis + multi-sample.** Run ≥3 samples to kill the n=13 temporal noise. This isolates where to invest.
- Expected: likely the largest single jump, zero architecture change.

### Tier 1 — Highest architectural ROI
1. **Contextual fact embedding + contextual BM25** (Anthropic Contextual Retrieval, fact-level). Embed each fact WITH a compact context stamp — speaker, addressee, session date, one-line situation of the originating turn — and index the same into the BM25 haystack. Anthropic: −35% (embeddings) / −49% (+BM25) retrieval-failure. Genuinely absent today. Files: `src/ingest/fact-embedding.service.ts`, `src/db/migrations/*search_haystack*`, extraction context already available at ingest. Needs re-ingest. **Effort: low-med, Impact: high.**
2. **Agent-in-loop retrieval orchestrator.** Wrap the EXISTING MCP read primitives (`search_knowledge`, `search_multi_hop`, `synthesize`, `graph_retrieve`, `get_entity_timeline`, `summarize_entity`, …) in a server-side ReAct loop: the answer LLM issues a search, inspects results, rewrites the query, chains, and decides when to answer. Biggest architectural lever in the literature (single-shot 67 → dumb agentic 74 → rich agentic 85). MCP surface already exposes the primitives (`src/mcp/read-tools.ts`); missing only the loop. Files: new orchestrator (e.g. `src/agent-qa/`), reuse `src/mcp/read-tools.ts`. **Effort: med-high, Impact: highest.**
3. **Temporal: extract event-time + as-of query path.** cat3 (~20% of questions) is the weakest + most improvable. Fix `validFrom = emittedAt` (message time) → lift in-text temporal expressions ("last summer", "in 2019") into a queryable event-time field; add temporal ordering/duration reasoning to the planner + ranking; surface the validity window (already partly done) to the answerer. Zep bi-temporal + Mem0-graph show temporal is the one place representation clearly moves a subcategory (+30-38%). Files: `src/ai/extractor-internals/prompts.ts` (temporal extraction), `src/ingest/mention-persist.service.ts` (validFrom), `src/search/internals/where-builder.ts`, `src/multi-hop/multi-hop-planner.service.ts`. **Effort: med, Impact: high on cat3.**

### Tier 2 — Structural
4. **Salience/importance at extraction.** Score how worth-remembering an utterance is (Generative Agents importance 1-10); gate/deprioritize backchannel before it becomes a fact, and feed importance into retention + ranking alongside decay. Directly attacks "entities buried under hundreds of low-value utterances" at the source (the chatterPenalty we just shipped is the ranking-side half; this is the extraction-side half — and the LLM ignored the prompt-only suppression, so a scored gate is the real fix). Files: `src/ai/extractor-internals/prompts.ts` + schema (add importance), `src/search/internals/scoring.ts`. **Effort: med, Impact: med-high.**
5. **Fact-centric retrieval path parallel to entity bucketing.** Today retrieval collapses facts into entity buckets; the reranker sees only an entity's top-3 facts and synthesis ≤ N/entity, so a fact ranked 4th+ is invisible and cross-entity evidence competes across buckets. Add a fact/passage-level rank+rerank path so the right facts (not just the right entities) reach synthesis. Files: `src/search/internals/scoring.ts` (bucketByEntity), `src/search/internals/response-builder.ts`, `src/search/search-rerank.service.ts`. **Effort: med-high, Impact: med-high (multi-hop/cross-entity).**
6. **Read the consolidation tier at query time.** Communities, promotion summaries, and compaction rollups are built but never read (search excludes `status='compacted'`). Surface a summary/semantic tier to synthesis for "tell me about X over time"/thematic questions, and split episodic log vs semantic facts with per-type retrieval. Files: `src/search/internals/where-builder.ts`, `src/communities/*`, `src/compaction/*`. **Effort: med, Impact: med.**

### Tier 3 — Tuning / smaller
7. **Adaptive multi-hop + PPR tuning + fix stale planner vocab.** Re-plan/re-retrieve on intermediate hop results (IRCoT) instead of one up-front plan; tune PPR seeding/restart as the multi-hop engine (HippoRAG mechanism already implemented, ~10-30× cheaper than LLM-loop); fix the hardcoded 12-predicate list in `PLANNER_SYSTEM` that diverges from the live registry. Files: `src/multi-hop/*`, `src/search/internals/ppr.ts`.
8. **True RRF instead of weighted 0.5/0.5 fusion** (minor; test against the recall@1 note that convex beat RRF at their scale — validate before switching). Files: `src/search/internals/fusion.ts`.
9. **Chain-of-Note noise filtering in synthesis** (+7.9 EM under heavy noise) and abstention calibration if cat5 is scored. Files: `src/synthesize/synthesize.service.ts`.
10. **Context-assembly discipline** — head/tail ordering (lost-in-the-middle), dedup, summarize-on-read. Files: `src/synthesize/synthesize.service.ts` buildFactIndex.

### Explicitly deprioritized (research consensus)
- Query-time HyDE — most likely to *hurt* an entity-centric factoid store.
- Full Microsoft GraphRAG community pipeline — targets global sensemaking, not conversational-fact QA; heavy indexing cost. (We already have cheaper communities.)
- More reranking — already run cross-encoder + RankGPT.
- Self-RAG — fine-tuning cost not justified; gaps are upstream.

## Recommended sequence
Tier 0 (measure honestly, never-abstain) → re-run → then Tier 1 in order (contextual embedding needs re-ingest anyway; do it with the agent-loop; temporal alongside). Validate each on multi-sample J + per-category. Everything default-off / flag-gated per repo culture; roll to prod after golden-baseline A/B.

## Key citations
Mem0 arXiv:2504.19413 · Zep/Graphiti 2501.13956 · MemGPT/Letta 2310.08560 (+letta benchmark blog) · LoCoMo 2402.17753 · MIRIX 2507.07957 · HippoRAG 2405.14831 / 2 2502.14802 · Anthropic Contextual Retrieval (2024) · Generative Agents 2304.03442 · CoALA 2309.02427 · IRCoT 2212.10509 · Chain-of-Note 2311.09210 · Penfield LoCoMo audit (6.4% wrong key) · LoCoMo-Refined (judge 43.67→86.33% human agreement).
</content>
