# Memory research 2026-08 — where the next points actually are

Five-way research pass (2026-08-16), run immediately after the V12/V13 program closed with
"the gpt-4o-mini exhaustive extraction stack is locally optimal on LoCoMo" (11 interventions,
1 positive; see `v11-session-2026-08.md` §13). Question: given that verdict, where do
substantial gains live? Sources: external landscape sweeps (LoCoMo SOTA claims, LongMemEval
/temporal literature, BEAM/LIGHT follow-ups, agent-memory trends and production-assistant
architectures) + an internal headroom map over our own eval reports. All external numbers
below carry the original protocol caveats; vendor self-reports are marked as such.

## 1. Verdicts that reframe the program

**V1. Our LoCoMo 77.8 is frontier-competitive, not lagging.** Independent audit (Penfield
Labs) found 6.4% score-corrupting gold errors in LoCoMo → perfect-system ceiling ≈ 93.6 under
an exact judge; the standard gpt-4o-mini judge accepts 62.8% of *intentionally wrong*
topically-adjacent answers. Most published numbers ride that lenient judge; ours ride a
strict gpt-4.1-mini judge — a different currency, plausibly equivalent to mid-80s in theirs.
The cleanest cap datapoint: MIRIX's full-context upper bound 87.5 (GPT-4.1 judge, strong
answerer), with their memory system at 97.5% of the bound. No >90 claim survives protocol
scrutiny except possibly Backboard 90.1 (public repro script, unverified). Chasing >85 by
protocol imitation would be measurement inflation, not engine improvement.

**V2. The field converged on exactly the two things we never built.** Every credible
Tier-1 leader keeps a path back to raw transcript text and searches more than once:

- *Raw episodic preservation.* Controlled ablation (arXiv 2601.00821, same retriever/reader/
  judge): fact-only substrate loses **−22pp overall / −14.2pp temporal** vs verbatim chunks;
  a semantic graph over facts does NOT recover the loss; hybrid (facts as index keys, raw
  turns as answer-time content) preserves accuracy. MemMachine (best comparable-protocol
  LoCoMo at 84.9) brands itself "ground-truth-preserving" and expands fact hits with
  surrounding raw turns; Letta hits 74.0 with *zero extraction* (raw files + grep + agentic
  loop); TSM's retrieval pool is raw chat turns with the temporal KG used only for
  localization; LongMemEval's own winning config is facts-as-keys/raw-as-content. Production
  mirrors this: no major assistant runs per-turn retrieval over an extracted fact DB.
- *Answer-time agentic retrieval.* MemMachine allows multiple memory searches; Letta's agent
  reformulates and searches until found; REMem reports +13.4pp reasoning from an agentic
  retriever. Our free-loop attempt (E11, −4.6) was unconstrained; the literature's shape is
  constrained (must-search-first, step caps, tool rules).

This reframes our discriminator: the 63% "gold absent from substrate" class is *structural
to extraction* and is recovered by retrieving episodes, not by extracting harder — which is
also why volume-nulls (V8) and deriver-model-swap negatives (V13 armM) were predicted
outcomes.

**V3. Temporal gains are construction-side; prompt-side nulls were predicted.** TSM
(+22.6pp temporal over best baseline): "temporal inaccuracy = organizing memories by dialogue
time rather than actual occurrence time" — verbatim our session-date collapse. Zep's
bi-temporal edge model: +17.3–17.6pp temporal. TISER: prompt-only timeline/reflection gives
+3–4pp on mini-class models (matches our armH/armK nulls/negatives). Time-constrained
retrieval (query time-range parse → filter/rerank) adds −6pp-if-removed in TSM's ablation but
*requires event-time-stamped facts to exist first*. Separately, PRIMETIME measures
gpt-4o-mini raw date arithmetic at **14–40% accuracy** in isolation (errors >100 days) —
a real slice of temporal misses is the generator failing calendar math, fixable with a
code tool or routing, never with retrieval. And "Don't Ask the LLM to Track Freshness":
LLM-extracted candidates + deterministic `max(valid-time)` aggregation at answer-assembly
beats every published system by +24–35pp on fact consolidation (Zep/Graphiti at 7%
multi-hop there) — conflict/freshness resolution belongs in code, at assembly time.

**V4. Our BEAM "at published SOTA" read is stale — headroom is +15pp.** SelfMem
(arXiv 2607.03726, self-optimizing memory agent) claims **0.504 @100K on the strict
protocol** vs LIGHT's 0.358 (our anchor); Router-Mem's plain full pipeline hits 43.3 on its
harness. So 0.40–0.45 looks claimable without exotic machinery. Two lanes are
protocol-capped, not capability-capped: contradiction resolution (0.006–0.05 for *all*
systems strict vs 91.4% under a lenient judge — never quote our internal 52–55 next to the
official 0.03) and event ordering is nearly so (0.16–0.22 for all — but that is Kendall-tau
over event sequences, i.e. exactly what per-turn timestamps would feed). We ported 3 of 4
LIGHT components; the unported one is **noise filtering** (binary chunk-relevance gate on
scratchpad content, ~+2pp @100K, growing with scale). Their retrieval-k ablation: k=15
optimal, +7–10%.

**V5. The absolute unclaimed mass is on LME, not LoCoMo.** Internal map: LoCoMo has ~62
addressable questions behind a ±2.2pp noise floor (locally optimal verdict stands). LME-500
has **234 misses of 470**, untouched since 2026-08-03, and the 50.2 headline is stale-low:
the V4 read-path wave already lifted the temporal mini-axis 24.4 → 41.7% but no full-500 run
exists on current code — ≈ +4.6pp headline is banked and unconfirmed ($15–20 to confirm).
The SSA episodic-lane leg is pre-designed (`next-session-measure-2026-08.md`) and SSA is the
episodic lane's native genre (null on LoCoMo was the wrong genre).

**V6. Production memory is a different shape than benchmark memory.** ChatGPT injects four
blocks with *every* message, no retrieval: interaction metadata, recent-conversations log,
user-visible memory entries (an override patch layer), and dense narrative user-knowledge
summaries batch-regenerated offline. Gemini keeps one `user_context` artifact with
per-statement timestamp+provenance. Claude keeps raw transcripts as ground truth behind
search tools. Cursor *removed* silent auto-extracted memories in favor of curated rules — a
market datapoint against silent fact mining. The convergent production stack = rolling
profile summary + raw recency + user-visible entries; misses become attention problems, not
selection problems. Separately, the 2026 benchmark frontier moved to preference drift /
prospective memory / over-personalization (PrefEval, PersonaMem, PM-Bench, OP-Bench) where
*no system wins yet*, and ReasoningBank-style failure-distilled strategy memory shows
+4.6–8.3pp on agent tasks with k=1 retrieval (more memory hurts; raw trajectories hurt;
distilled failures help).

## 2. Ranked program

### Tier 0 — banked money on the table (days, ~$25 total)

| # | Item | Evidence | Expected | Cost |
|---|------|----------|----------|------|
| 0.1 | LME full-500 confirm on current code (re-ingest worlds, run once) | our own banked temporal fixes (24.4→41.7 on mini-axis) | ≈ +4.6pp LME headline | $15–20 |
| 0.2 | verifierModel=gpt-5-mini abstention confirm at n≥120 | +5pp at n=40, direction-positive all session | default-on decision | ~$1–2 |
| 0.3 | BEAM cheap pair: retrieval k≈15 + LIGHT noise-filter port | LIGHT ablations (+7–10% and ~+2pp) | +2–4pp nugget | 1–2 legs |
| 0.4 | Digest gate-shaping: digest lines only into summ/KU lanes | +5.0 strict already measured; nugget flat from lane bleed | keep the strict gain, stop the abstention −7.5 | 1 leg |

### Tier 1 — the structural spine: "time + raw text" (the V13 build)

| # | Item | Evidence | Target |
|---|------|----------|--------|
| 1.1 | **Hybrid substrate: facts as index, raw turns as content.** Expand fact hits into surrounding raw-turn windows at answer time (MemMachine's contextualized matching); episodic lane + `SYNTHESIZE_SOURCE_EXCERPTS` on LME SSA first (pre-designed leg), then MS/temporal | −22pp fact-only ablation; MemMachine/Letta/TSM/LongMemEval convergence | the 63% gold-absent class; LME SSA (25 misses/56q), MS (59), temporal |
| 1.2 | **Event-time grounding**: per-turn timestamp headers + `episode_indices` in the deriver (graphiti shape, already speced §11), fact→turn index | TSM +22.6, Zep +17.5; all >15pp temporal wins are construction-side | BEAM event_ordering (0.0 strict!) + temporal; LME temporal |
| 1.3 | **Time-constrained retrieval** on top of 1.2: query time-range parse → in-range filter + temporal-first rerank | TSM ablation −6pp temporal if removed; +7–11% temporal recall (LongMemEval) | LME temporal residue (~74 q at 41.7%) |
| 1.4 | **Deterministic temporal assembly**: freshness/conflict winner picked by code (`max(validFrom)` after LLM candidate-matching); date arithmetic via code tool for the generator | +24–35pp fact-consolidation; PRIMETIME 14–40% mini-class date math | KU lanes, off-by-days class, temporal |

Guard: armK proved session-date defaults ARE the LoCoMo answer convention — 1.2–1.4 must
add event time without stripping session-date fallback, and confirm on fresh derivedVersions
with nugget-primary temporal targets (derive floor ±0.8pp headline / ±3.5 per-cat).

### Tier 2 — control layer (after Tier 1 lands)

- **Constrained agentic retrieval**: must-search-first rule + step cap + reformulate-on-miss
  (the E11 free loop measured −4.6; the constrained shape is what MemMachine/Letta/REMem
  actually run). Attacks the 22% gold-in-window + 15% selection classes.
- **G2 per-category answer conditioning** (never built; Penfield +10.7pp prompt-alone
  evidence; ceiling ≈ +4.9pp LoCoMo, 37 in-window misses) + Chain-of-Note-style structured
  reading (+10 abs in LongMemEval's ablation).
- **Re-swap the answer model on the hybrid substrate.** Others get +7pp from
  4o-mini→4.1-mini *on raw-preserving substrates with lenient judges*; our −6.6 (armP) was
  measured on a fact-only substrate under a strict judge. The negative may be a substrate
  property, not a model property — one paired leg after 1.1.

### Tier 3 — "insane memory" beyond QA benchmarks (product differentiation)

1. **Rolling user-summary artifact** — always-injected narrative profile per
   (company, user), batch-regenerated offline from the existing fact store (dreams/digest
   infrastructure already does 80% of this), per-statement timestamps + provenance
   ("because you said X on date Y"). Production-unanimous pattern; also attacks
   selection-dependence structurally.
2. **Failure-distilled strategy memory** (ReasoningBank shape): our eval harness knows every
   miss and its diagnosis; distill post-mortems into reusable answer strategies, retrieve
   k=1. Cheap — reuses derive infra as a new lane.
3. **Sleep-time consolidation** — idle-window contradiction sweeps + schema induction over
   episodes (Letta sleep-time; our substrate-refresh +3.0 was the only positive of V13 and
   is weak evidence in the same direction).
4. **New benchmark adoption + judge audit** — PrefEval / PersonaMem / PM-Bench (preference
   drift, prospective memory, over-personalization: no winner exists, differentiation is
   cheap); MemOps-style operation-level lifecycle diagnostics (session-granularity retrieval
   beat turn-granularity by +23pp there); calibrate our own judge against the
   Penfield-style intentionally-wrong probe set.
5. **Memory security red-team** before any shared-memory exposure: MINJA-class query-only
   memory injection succeeds >95% against published systems.

### Explicitly not worth chasing

- LoCoMo read-side flags (six nulls; ±2.2pp floor; 63% of residual miss mass dataset-capped).
- BEAM contradiction lane vs the official metric (judge-protocol-capped for everyone).
- Per-user parametric memory / LoRA-as-memory (Temp-LoRA 0.162 vs 0.85 long-context; edit
  contamination) — corpus-level KV cartridges are the only viable parametric niche.
- Protocol imitation of >85 LoCoMo claims (lenient-judge currency).
- Naked prompt-side temporal rules (proved null here; predicted +3–4pp ceiling in TISER).

## 3. Protocol hygiene for anything we publish

Any external number must pin: judge model + strictness probe, answer model, category set
(cat-5 in/out), split, n, and retrieval budget (tokens/query). Three incompatible BEAM score
families and a 20–40pp vendor-inflation gap on LoCoMo/LME make unpinned numbers
uninterpretable. Our strict-judge currency is a *publishing asset*: worth one
Backboard-repro run and one lenient-judge re-score of our own control before any public
comparison. Open citable gap if we want one: no frontier 2026 model has published
full-context strict-protocol BEAM numbers at any tier.

## 4. Load-bearing sources

- TSM — arXiv 2601.07468 (third-party system table; temporal construction-side ablations)
- Verbatim chunks vs artifacts — arXiv 2601.00821 (the −22pp fact-only ablation)
- Beyond the Context Window — arXiv 2603.04814 (full-context vs memory cost frontier)
- Zep bi-temporal KG — arXiv 2501.13956 · LongMemEval — arXiv 2410.10813 (oracle ceiling ≈92)
- BEAM/LIGHT — arXiv 2510.27246 (ICLR 2026) · SelfMem — arXiv 2607.03726 · Router-Mem — arXiv 2608.01285
- MIRIX — arXiv 2507.07957 (85.4, full-context bound 87.5) · MemMachine — arXiv 2604.04853
- Letta filesystem agents — letta.com/blog/benchmarking-ai-agent-memory (74.0, zero extraction)
- Penfield LoCoMo audit — penfieldlabs.substack.com (6.4% gold errors; judge accepts 62.8% wrong)
- Don't Ask the LLM to Track Freshness — arXiv 2606.01435 (+24–35pp deterministic assembly)
- PRIMETIME — arXiv 2504.16155 (mini-class date arithmetic 14–40%) · TISER — arXiv 2504.05258
- ReasoningBank — arXiv 2509.25140 · MemOps — arXiv 2607.12893 · MINJA — arXiv 2503.03704
- Production reverse-engineering — shloked.com (ChatGPT/Claude/Gemini memory architectures)

## 5. V13 build (2026-08-17) — what was built, how to measure it

Everything below is default-off, per-tenant configuration (no eval forks); goldens
carry the flag budget (engine flags 45→52, retrieval keys 24→32). Unit coverage:
`time-range.unit-spec`, `v13-answer-frames.unit-spec`, `turn-headers.unit-spec`.

| # | Lever | Flag(s) | Target axis / expectation |
|---|-------|---------|---------------------------|
| B1 | Raw-turn window: fact hits expand to surrounding raw turns (facts-as-index) | `RETRIEVAL_RAW_WINDOW` (+`RETRIEVAL_RAW_WINDOW_SPAN`, default 2) | The 63% gold-absent class. First leg: LME SSA (episodic lane's native genre), then LME MS/temporal; LoCoMo pair as sanity. Literature: −22pp fact-only ablation. |
| B2 | Per-turn timestamp headers in the deriver (event-time grounding) | `DERIVER_TURN_HEADERS` — **fresh derivedVersion required** | BEAM event_ordering (0.0 strict) + temporal nugget; LME temporal. Read with nugget-primary target; derive floor ±0.8pp headline / ±3.5 per-cat. Session-date fallback kept (armK guard). |
| B3 | Time-constrained retrieval: query-named absolute period boosts in-range facts | `RETRIEVAL_TIME_FILTER` | LME temporal residue (~74 q at 41.7%). Open-ended rows anchor on validFrom as event day; closed intervals overlap honestly; mention stamp rescues. Inert when the query names no absolute period. |
| B4 | Deterministic date table (weekday + event-to-event gaps, computed in code) | `RETRIEVAL_DATE_MATH` | LoCoMo temporal + LME temporal. PRIMETIME: mini-class raw date math is 14-40%. No "elapsed before today" frame. Verifier sees the same table. |
| B5 | G2 per-shape answer conditioning (chained / aggregation / verbatim) | `RETRIEVAL_ANSWER_CONDITIONING` | The 22% gold-in-window class, ceiling ≈ +4.9pp LoCoMo (MH 61.3% + OD 43.5% are the shape targets). |
| B6 | Constrained search loop: ONE structured refine round, then forced answer | `RETRIEVAL_SEARCH_LOOP` | The 22%+15% classes; MemMachine/Letta shape. NOT the E11 free loop (that measured −4.6). Watch `search_loop_refined` counter for fire rate; cost = ≤1 extra search + 1 extra generation per fired question. |
| B7 | Digest gate-shaping: digest lines only into summary/recency-routed prompts | `RETRIEVAL_DIGEST_LANES=summary_ku` (with `RETRIEVAL_DIGEST_EVIDENCE=1`) | BEAM: keep the +5.0 strict (KU +15) while un-bleeding abstention (−7.5) and summ nugget (−1.9). |
| B8 | Noise filter: cross-encoder relevance gate on injected context lines | `RETRIEVAL_NOISE_FILTER` | BEAM nugget (+~2pp per LIGHT's ablation at 100K). Needs the local CE (`SEARCH_CROSS_ENCODER_LOCAL_WORKER=0` on the eval stand). Facts and the mention record are never filtered. |
| B9 | Cross-session composition pass: one LLM call per conversation composes multi-atom facts (PREMem shape) | `DERIVER_COMPOSE_PASS` — **fresh derivedVersion required** | LoCoMo multi-hop (61.3%, largest miss bucket = composed-fact-absent) + LME MS. On-genre published ablation +3-7pp concentrated on multi-hop; the graph research verdict: assemble chains at write time or by read iteration, never by static traversal (edge-expansion NULL doubly confirmed by HippoRAG's own neighbor ablation). Pairs naturally with B2 on the same fresh derive. |
| B10 | Scene traces: per-fact one-clause encoding context, stamped + folded into the embedding (dual-trace port, arXiv 2604.12948) | `DERIVER_SCENE_TRACE` (write, **fresh derivedVersion**) + `RETRIEVAL_SCENE_TRACES` (read render) | The single largest published effect found in the research pass: +20.2pp LongMemEval-S overall, temporal +40pp, KU +25pp, multi-session +30pp in their controlled pair (single-session +0 — expect gains on cross-session axes). Mechanism = encoding specificity, pure text. Pairs with B2/B9 on the same fresh derive. |

Recommended measurement order (cheap → expensive, banked confirms first):

1. **Tier-0 confirms (unchanged by this build):** LME full-500 on current code
   (banked ≈ +4.6pp, $15-20, worlds need re-ingest — commands in
   `next-session-measure-2026-08.md`); verifier=gpt-5-mini at n≥120 on the BEAM
   abstention block; BEAM k-tuning legs (`SEARCH_SEGMENT_LANE_TOPK`/
   `SEARCH_EPISODIC_LANE_TOPK` ≈ 15).
2. **BEAM read pack (cheapest legs, ~$1-2 each, --skip-ingest):** B7, B8, B4 —
   nugget-primary via `scripts/offline-nugget-score.ts`; per-ability n=40 → ±8pp
   strict noise, decide on nugget.
3. **LME SSA leg (B1):** `SEARCH_EPISODIC_LANE_ENABLED=1 SYNTHESIZE_SOURCE_EXCERPTS=1
   RETRIEVAL_RAW_WINDOW=1` on SSA indices 444-499 (56-world rebuild once); then
   temporal block 233-365 with B3+B4.
4. **LoCoMo pair (sanity, $2-3/arm):** ctl vs B1+B4+B5+B6 combined on wd-v3s
   (`--skip-ingest`, guardrails answer, McNemar via
   `scripts/eval-analysis/locomo-mcnemar.py`; ±2.2pp floor — only a combined leg
   has a chance to read).
5. **B2 derive leg (most expensive, quota-gated):** fresh `wd-v6t` derive on
   loco-321 with `DERIVER_TURN_HEADERS=1`, then BEAM EO/temporal nugget target
   (re-segment worlds 11/12/18/19/20 first — they have zero episode_segment rows).

Stand reminders: source `.env` BEFORE exports; registry live-row beats
`RETRIEVAL_DERIVED_VERSION`; loco-321 = volume `loco321_rocks` on
`surrealdb/surrealdb:latest` (3.2.1 — 3.1.5 breaks index state) with
`--restart unless-stopped --memory 4g`; `--resume` accepts a report-synthesized
checkpoint after any interrupt.
