# Memory rebuild — structural refactor plan (2026-07-26)

Successor to `memory-substrate-redesign-2026-07.md` (L0/L1/L2, implemented through
P3 wd-v2) and `locomo-sota-architecture-2026-07.md` §6 (road-to-90). Grounded in
three implementation-grade research sweeps (write pipelines, agentic read loops,
multi-granularity retention — full reports in the session transcript) plus our
own E-series measurements.

## 1. Where we stand and why patches stopped working

wd-v2 session-window derivation + PA2 read flags = **70.6% dev-5 / 69.7% held-out
= full-context parity** at ~3% of the tokens. Since then, three read-side add-ons
measured null (episodic BM25 lane ×2, provenance source-excerpts), the generator
swap gained only +2.1 n.s., and caption-complete re-ingest through the same
deriver was flat. The literature predicted every one of these nulls:

- **Provenance quoting of selected facts cannot fix selection at the wrong
  granularity** (CogCanvas/Fidelity-Before-Structure, arXiv 2601.00821: verbatim
  chunks 43.9% vs extracted artifacts 28.0%; artifacts+quotes still lose).
- **The read path, not the write strategy, carries the variance**: 3×3 controlled
  grid (arXiv 2603.02473) — retrieval method spans 20pp (57.1→77.2), write
  strategy only 3–8pp, on LoCoMo.
- **Summarizing derivation is intrinsically lossy** (SeCom: summary-memory −17.7
  vs segment-memory; fidelity dial: accuracy tracks fraction of surviving source
  text monotonically).

Conclusion: stop tuning lanes over a lossy L1. Rebuild the read path so **raw L0
is a first-class retrieval citizen**, then upgrade derivation where measured
evidence exists.

## 2. Target architecture

Four additions, each flag-gated, each measurable in isolation on dev-5 with the
existing judge protocol. L0 (immutable episodes) and versioned L1 derivations
stay exactly as built — everything below is additional lanes and passes.

### R1 — L0 segment lane: union retrieval + joint rerank  [BUILD FIRST]

Evidence: CogCanvas union (chunks∪artifacts ≈ chunks-only, ≫ artifacts-only);
SiReRAG flat union pool (+7.8% with rerank); RAPTOR collapsed-tree beats
drill-down; SeCom segment > turn > session ≫ summary; rerank R@5 0.587→0.816.

- New table `episode_segment`: topical segments of 3–8 turns (~150–300 tokens)
  over existing `episode` rows. Segmentation: sliding window (4 turns, stride 2)
  as the v1 baseline; LLM topical segmentation (SeCom/Nemori "when in doubt,
  split") as v2 if v1 measures well. Fields: `episodeIds[]`, `text` (verbatim,
  speaker-attributed, session-dated), `conversationId`, `occurredAt`, dense
  embedding + BM25 via the existing episode analyzer idiom.
- Read: segment lane retrieves dense+BM25 in parallel with the proposition lane;
  candidates merge into ONE pool; **cross-encoder rerank** (the repo ships one,
  flag-gated since v0.5.0) ranks the union; budget fill keeps propositions as the
  compact reasoning layer + cap N=4–6 segments as the verbatim detail layer.
  Single-shot synthesis unchanged.
- Flags: `SEARCH_SEGMENT_LANE_ENABLED`, `SEARCH_SEGMENT_LANE_TOPK`,
  `SEARCH_UNION_RERANK_ENABLED`.
- Expected (from external measurements mapped to our failure decomposition):
  open-domain and detail single-hop are the target: +4–7pp overall dev-5.

### R2 — Observation-log lane (Mastra OM port)

Evidence: OM 84.23 vs oracle 82.4 vs FC 60.2 at fixed gpt-4o (LongMemEval-S);
94.87 with gpt-5-mini; ingestion model fixed while answer model varies — the
substrate carries the gain. Open-source prompts.

- New tables `observation_log` (scope, generation, status, supersedes,
  tokenCount, coveredThrough watermark) + `observation_line` (seq, saidAt,
  resolvedDate, priority, near-verbatim text, episodeRefs provenance).
- Write: one Observer call per closed session appends dated, priority-tagged,
  near-verbatim lines (Mastra's rules: split multi-event lines, preserve unusual
  phrasing, counts first, state changes as supersessions, dual temporal
  anchoring). Reflection = full rewrite at token budget with the 4-level
  compression ladder, versioned via `generation+1` — maps 1:1 onto our
  versioned-derivation machinery.
- Read: the ENTIRE active log ships in the synthesis prompt as a stable prefix
  (no retrieval to miss). At LoCoMo scale the log is 4–8k tokens; in prod this
  lane is per-user bounded and cache-friendly.
- Flags: `OBSERVATION_LOG_ENABLED`, `OBSERVATION_LOG_BUDGET_TOKENS`.
- Guard rule for reflection: "never merge countable events" (protects
  enumeration questions).

### R3 — Agentic read loop for routed questions

Evidence: Letta filesystem 74.0 on gpt-4o-mini (tool rules, not planner IQ);
MemR³ +6.0pp overall on gpt-4o-mini with **masked retrieval as the largest
ablation (−13pp without)**; MIRIX typed fan-out = only system beating own FC on
multi-hop; Adaptive-RAG: even a 54%-accurate router pays.

- Extend `agent-qa` (existing ReAct skeleton) with tools: `search_memory`
  (lane-parameterized, **masked** — ids already seen this question are excluded),
  `grep_episodes` (literal/regex over transcripts with context turns),
  `read_session`, `timeline` (aspect/entity chronological scan — the
  enumerator), `answer` (terminal, evidence ids + confidence).
- Controller state between steps: strict JSON `{evidence bullets, gaps,
  decision, next_query}` (MemR³); deterministic overrides: step≥6 → answer,
  empty results → reflect then switch lane, ≥2 reflects → retrieve. Letta's
  date-arithmetic system-prompt block imported verbatim.
- Routing: static pre-route (enumeration/count markers, temporal comparators,
  ≥2 entities) + escalation when one-shot synthesis returns no citable evidence
  or hedges. Log route decisions for a future trained router.
- Flags: `AGENT_QA_TOOLS_V2`, `AGENT_QA_MAX_STEPS`, routing knobs.

### R4 — Derivation upgrades (write side, keep the deriver, add passes)

- **Gleanings pass** (GraphRAG): after the deriver emits propositions for a
  window, one forced "MANY facts were missed…" continuation + Y/N check. Cheap,
  directly targets measured extraction lossiness.
- **Prediction-gap derivation** (Nemori, +0.097 measured over direct
  extraction): before deriving a window, predict its content from existing L1;
  emit only what the prediction missed/misrepresented. Prunes redundant
  propositions by construction — replaces blanket re-derivation for
  incremental prod use.
- **Aspect theories at θ=3** (RGMem RK1, sharp empirical peak at 3): per
  (entity, aspect) mention counters; at ≥3 refresh a dated enumeration theory
  ("attended pottery on 10-27, 11-03, 11-17") into the SAME collapsed index.
  (Σ,Δ) dual summaries at profile level later if conflict questions matter.
- **Detail pass with sourceQuote field**: second derivation emission "list ALL
  concrete attributes (what exactly, color, count, with whom), one per line,
  each with verbatim quote" → `detail_fact` rows, same index, no promotion or
  compaction lifecycle.

## 3. Measurement ladder

Same protocol as the E-series: dev-5 iterates (one variable per leg, paired
McNemar vs E3 = 70.6%), held-out conv-44..50 confirms milestones, judge
gpt-4.1-mini strict, cat5 = abstention, dead-answer sanity every run.

| Leg | Variable | Gate |
|---|---|---|
| E9 | R1 segment lane + union rerank | ship if headline +≥2pp or open-domain +≥8pp, temporal not worse |
| E10 | R2 observation log (on top of winner) | same |
| E11 | R3 agentic loop, routed subset | per-category on routed categories |
| E12 | R4 passes, one at a time | multi-hop enumeration bucket |
| E13 | held-out confirmation of the stacked winner | milestone |

Anti-patterns to skip (measured failures elsewhere): destructive neighbor
evolution (A-Mem embedding desync), delete-reinsert updates (MIRIX), free
clustering instead of fixed aspect ontology (−19–24pp in RGMem's sweep),
per-observation updates without thresholds (−4pp at +30% tokens).

## 4. Protocol axes (unchanged)

Honest axis: gpt-4o-mini generator + strict judge — target 78–83 (verifiable
SOTA class; nobody demonstrably >85 here). Club axis: `SYNTHESIZE_MODEL=
gpt-4.1-mini` — report alongside for comparability with published 85–92 systems.
Dataset ceilings under strict judging (Penfield audit): single-hop 91–94,
multi-hop 84–88, temporal 78–85, open-domain 65–75.
