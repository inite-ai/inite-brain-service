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
systems strict vs 60.6 under the vendor AMB harness — a ≥12× lane inflation; the earlier
"91.4% lenient CR" marker in this doc was a mis-mapped citation, 91.4 is Hindsight's
LongMemEval headline. Never quote our internal 52–55 next to the official 0.03) and event ordering is nearly so (0.16–0.22 for all — but that is Kendall-tau
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

**Ontological grounding rule (2026-08-17).** Without expert-grounded ontology on
both ends of the pipe, hallucinated synthetics score 90+ on ANY genre — KG,
documents, or dialogue (measured: the standard lenient judge accepts 62.8% of
intentionally-wrong topically-adjacent answers; 56% of per-category comparisons
are noise). The defenses are structural, and this engine already carries them
as per-tenant configuration, not forks: write-side — closed expert predicate
vocabulary, fixed aspect ontology, span-grounding, per-proposition turn
grounding, compose-pass member validation (a hallucinated composition cannot
invent provenance); read-side — factId citations + verifier-against-evidence;
eval-side — strict judge + nugget decomposition. **Standing gate for any NEW
eval axis (including the future documents axis): a judge-calibration probe —
score a set of intentionally-wrong, topically-adjacent answers and report the
judge's acceptance rate next to the headline.** An axis without this number is
not evidence; a 90+ on it is not a result.

**AMB leaderboard forensic (2026-08-19; Exabase M-1 76.9 / Hindsight 73.4 /
Honcho 63.0 @100K).** The board (agentmemorybenchmark.ai) is owned by Vectorize
— the vendor of Hindsight, the #2 entry; the #1 entry (Exabase) forked the
owner's harness and ran Gemini 3 Flash as BOTH answerer and judge; submissions
are self-run, the judge is unpinned, and the harness README itself admits
"small changes can swing accuracy scores by double digits". Question set is a
per-tier regeneration (~400 @100K), not the paper's validated 2,000. Academic
strict-protocol systems appear only as pasted original-paper numbers next to
vendor-harness numbers (direct cross-currency conflation); the official BEAM
project page hosts no leaderboard at all. Currency triangulation (CR-lane
inflation ≥12×; rubric-shape factor 1.3× measured on our own strict pair):
lenient(AMB) ≈ 1.5–2.0× strict-nugget, placing all three at ~0.32–0.51
strict-equivalent — statistically indistinguishable from our measured 0.46,
likely above only Honcho. The one ablation-backed takeaway in the trio:
Honcho's dreaming ON/OFF — consolidation helps @100K, off is better ≥500K —
independently confirming our V9 lifecycle-parity law. Exabase's
salience-modulated decay (the fovea program's interest): two sentences of
proprietary prose, zero ablations — not citable as evidence. Meta-rule
adopted: demand the bare-backbone delta from every vendor claim (Honcho's own
LoCoMo delta over bare Haiku is +6pp — the honest size of a memory system's
contribution under a modern backbone).

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

## 6. Follow-up research: graph utilization (2026-08-17)

Question: are we leaving points on the table by not exploiting graph structure
"NN-style" (PPR, GNN rerankers, projections)? Verdict: **no — for this genre the
graph-read hypothesis fails the transfer test**, with one productive exception.

- Our edge-expansion NULL is now doubly confirmed: HippoRAG 1's own ablation has
  "query nodes + neighbors" WORSE than query-nodes-only (R@2 25.4 vs 37.1 on
  MuSiQue) — unscored k-hop expansion injects noise even on the graph-friendliest
  benchmarks. Do not build 2-hop variants.
- Graph storage loses multi-hop on-genre: Mem0 vs Mem0g (same vendor, 10 runs):
  graph variant −3.96pp multi-hop LoCoMo, 3.2× latency. PPR wins concentrate on
  entity-chain Wikipedia QA (2Wiki); every third-party read of HippoRAG-family on
  conversational memory is mid-pack (61.6 LoCoMo / 45.9 LME / 54% single-hop
  FactConsolidation). GNN rerankers / graph embeddings / G-Retriever: curated-KG
  genre, no conversational evidence, training burden — not production-viable here.
- The exception (what the field's on-genre ablations actually credit): assemble
  chains at **write time** (PREMem composition, +3-7pp ablated, gains on
  multi-hop — built as B9) or by **read-time iteration** (MRAgent's ablation:
  iteration > structure; REMem +13.4 reasoning — built as B6 in constrained
  form). Static path-retrieval + path-rendering has no published on-genre
  evidence; if we ever test it, that is novel territory.
- Only PPR variant worth one cheap paired run someday: seed the walk from
  query-to-TRIPLE matches (HippoRAG 2's +12.5 recall component), not entity
  nodes. Expectation per transfer evidence: null to small.

Key sources: arXiv 2405.14831 (Table 5), 2502.14802, 2504.19413, 2509.10852
(PREMem), 2606.06036 (MRAgent), 2604.09666, 2602.13530.

**Genre-conditionality caveat (platform lens, 2026-08-17).** The verdict above
is conditional on the CONVERSATIONAL genre, because all three of our eval axes
are conversational — and this engine is a universal memory platform
(`RetrievalProfile.genre`: dialogue / assistant_chat / documents; doc-ingest
pipeline, CRM verticals, domain packs). The same literature says graph levers
DO pay elsewhere: PPR on entity-chain QA over clean KGs, GraphRAG community
summaries on global-sensemaking over document corpora, and even Mem0g's own
ablation had the graph WINNING temporal (+2.6) and open-domain (+2.8) while
losing multi-hop. The platform-correct posture is therefore per-genre
configuration, not removal — which the α=0 default already implements (the
segment-lane precedent: genre-dependent sign, resolved by profile, not by
deletion). **Recorded gap:** we have NO non-conversational eval axis, so
genre-conditional levers are unmeasurable exactly where they should pay. Work
item for a future program: a documents-genre axis (GraphRAG-Bench /
MuSiQue-class over our doc-ingest path) before investing further in — or
retiring — graph machinery platform-wide.

## 7. Follow-up research: compression/decompression + multimodal (2026-08-17)

Frame: memory IS rate-distortion coding — and the 2026 field now says this
explicitly (arXiv 2605.10870 decision-centric RD; 2607.08032 RD survey). The
empirical consensus converges on exactly our architecture: facts→KEYS, topical
segments→retrieval unit, raw turns→VALUES, distortion measured at decision time.

- **Dual-trace encoding is the single largest published effect found in the
  whole research pass**: fact + one-clause scene trace of the context it was
  learned in → +20.2pp LongMemEval-S (95% CI +12.1..+29.3), temporal +40pp,
  KU +25pp, single-session +0 (arXiv 2604.12948). Pure text; the mechanism is
  encoding specificity, not imagery — built as B10.
- High-ratio compression does not survive for memory: LLMLingua-class degrades
  −47% between 1.5× and 3.4× on extractive QA; 500xCompressor retains 62-73% of
  capability; ~4× query-aware denoising is the reliable plateau. Soft-token/KV
  memory (gist, ICAE, cartridges) is model-weight-locked and per-corpus-trained —
  dead for an append-heavy dialogue store; KV eviction compounds degradation
  per turn. Text-space substrates (ours) remain the only portable medium.
- Granularity ladder (SeCom ICLR 2025, cleanest ablation): topical SEGMENT beats
  turn and session as the retrieval unit — a future knob for our segment
  composer (WINDOW=4 fixed windows today).
- Sleep-vs-read split: precompute the index and stable derivations (sleep-time
  compute ~5× test-compute savings when queries are predictable), reconstruct
  content from raw at answer time (raw replay beats precomputed fact stores on
  content fidelity). Recursive summary-of-summaries decay is real but UNMEASURED
  in the field — a cheap novel in-house measurement if we want one.
- Multimodal: gains exist only where images carry unverbalized information
  (Mem-Gallery: naive image accumulation UNDERPERFORMS text-only; DualMem:
  cross-modal keys retrieve what caption keys miss on incidental visual cues).
  For LoCoMo specifically, re-captioning BLIP-2 images with a modern VLM is
  structurally risky: golds were authored against the original captions — an
  unmeasured lever with asymmetric downside. The transferable insight for a
  text team is context-binding, i.e. B10.

Key sources: arXiv 2604.12948 (dual-trace), 2502.05589 (SeCom), 2509.21212
(SGMem), 2605.10870 + 2607.08032 (RD framing), 2504.13171 (sleep-time),
2506.06266 (cartridges), 2601.03515 (Mem-Gallery), 2606.27499 (DualMem),
2512.04763 (LoCoMo-V captions 23% vs native vision 81%).

**Rigor audit of §6 (steelman pass, 2026-08-17).** An adversarial re-audit
against top-venue evidence corrects three things. (1) MRAgent (NUS, ICML 2026
accepted, code released) is the strongest PRO-graph result on our genre and our
first pass miscategorized it: LoCoMo 84.21 vs Mem0 68.31, LongMemEval 72.95 vs
RAG 54.65, token-cheaper than Mem0/A-Mem; its ablation shows structure helping
MONOTONICALLY (CE<CTE<CTC, ~+5-12pp multi-hop recall) on top of the iteration
effect its own Theorem 4.1 locates the power in. Missing control: the same
active loop over a FLAT store. (2) "Fidelity Before Structure" (2601.00821) is
single-author, not yet peer-reviewed — downgraded from how §6 used it
(direction corroborated by PKU "Does Memory Need Graphs?" and Salesforce
ConvoMem). (3) Mem0-vs-Mem0g is vendor-grade on both sides — corroboration
only, never primary. Narrowed verdict that SURVIVES: no work anywhere shows
graph structure beating a strong flat substrate (verbatim chunks + hybrid
retrieval + reranker + adaptive retrieval) at matched adaptivity and budget on
conversational memory; every big pro-graph win decomposes into iteration,
genre transfer, or weak baselines; no major lab ships KG-structured
conversational memory (OpenAI Dreaming V3 = synthesis, no KG).

**The settling experiment (E-graph) — runnable on existing flags, zero new
code**: a 2×2 on LoCoMo-MH + LME — {edge expansion α=0 / α>0} ×
{RETRIEVAL_SEARCH_LOOP off / on}, matched budgets. Audit's prediction:
iteration ≫ one-shot on either substrate; edges add <4pp (below leg
readability) once iteration is on. If edges add ≥4pp on multi-hop WITH the
loop enabled, the MRAgent mechanism transfers and an associative-tags build
(their Cue-Tag-Content shape) enters the next program; otherwise the
anti-graph verdict is settled with the exact control the literature lacks.
Key rigor-audit sources: MRAgent 2606.06036 [ICML 2026], MemGAS [ICLR 2026,
structure <1.5 F1/component], GraphRAG-Bench 2506.05690 [ICLR 2026],
HippoRAG 2 [ICML 2025], DeepMind LIMIT 2508.21038 [theory], ConvoMem
2511.10523, "Does Memory Need Graphs?" 2601.01280.

## 8. Foveated memory — the resolution-cascade program (E-fovea, 2026-08-17)

Frame (the platform lens): foveated and uniform are not competing hypotheses but
LAYERS of one cascade priced by resolution — L0 profile/digest (always-on,
~free) → L1 fact index (one retrieval) → L2 raw windows at attention points
(built, `RETRIEVAL_RAW_WINDOW`) → L3 full-transcript escalation (NOT built —
no path today lifts a whole raw session into a large-context call). Escalation
triggers already exist (coverage floors, verifier verdicts, search-loop refine
signal); they currently lead to abstain/re-search, never UP a layer.

External evidence (full payloads in session research): FOVI's inverted-U — at
matched budget, non-uniform allocation beats uniform; Mastra OM — a plain
3-rung resolution ladder scores 94.87 LongMemEval vs 60.2 full-context (and is
prompt-cacheable, 4-10× cheaper); irreversible decay is dead (compression
−35pp vs raw; super-linear error compounding under repeated summarization —
RD theorem: reversibility beats scoring tricks; STALE: staleness detection
needs the raw you'd delete). **Never degrade L0** — policies grade the DEFAULT
SERVING layer only. The direct "age-graded serving vs uniform at matched token
budget" ablation is UNPUBLISHED anywhere — E1 below is simultaneously our leg
and a citable result. Predictive gaze: proven as latency (−62% TTFT, hit-rate
78%), unproven as accuracy and gated by the sleep-time predictability law —
E2 carries a hit-rate go/no-go before any accuracy bet. RL memory policies
(MemAgent ICLR-2026 oral): strong but weights-owner territory — not us.

Internal map (signal inventory, agent pass over the repo): the machinery mostly
EXISTS and is unconnected —
- `fact_usage` side table (0053) with `readCount` written-and-never-read;
  `SEARCH_USAGE_RECORDING_ENABLED` / `SEARCH_USAGE_DECAY_ENABLED` both default
  off. Flip recording first — the table is empty until then.
- Write-tier machinery already runs: compaction (hot retention 90d) +
  episodic→semantic promotion (180d, default off) — keyed `(entity,predicate)`,
  not conversation; `conversation_digest` IS the per-conversation cold-tier
  artifact, with `lastIngestAt` documented as the incremental-fold hook.
- CONFIRMED absent: any age/usage conditioning in evidence-gates/collector; any
  prefetch before a query (all probes fire inside an in-flight request); any
  per-conversation budgets (profile is per-tenant, resolved once in the guard);
  any conversation-open lifecycle host (MCP stateless by construction).
- Found wrinkle: ranking-time decay uses the seed `policyFor`, not the
  tenant-aware registry — tenant-added predicates decay at the 60d default
  regardless of their registry entry (small fix candidate).

Experiments (cheap → expensive), mapped to code seams:
- **E1 — age-graded serving vs uniform at matched tokens** (read-side only, no
  re-ingest): recent sessions serve raw windows, mid-age digests, old
  facts-only vs the uniform mix. Seams: evidence-gates/collector heat argument
  (digest-lane's `lastEventAt` widened to a heat table); per-conversation
  budget overlay via the ALS profile re-stamp (the guard's own idiom). Score
  per age band: LME loader has both dates (`meta` flows to score rows
  verbatim); LoCoMo needs one derivation (asOf is pinned to last session —
  the one line that erases age). Expect FOVI's inverted-U.
- **E2 — prefetch with a predictability gate**: 4a alongside-query probe (one
  LANE_REGISTRY entry, wideProbe as the template) and/or 4b sleep-time dreams
  op (PromotionRunner as the reference for a bounded nightly pass). Go/no-go =
  prefetch hit rate BEFORE any accuracy claim; product metric = TTFT.
- **E3 — surprise-gated extraction depth** (write-side): high-novelty turns get
  exhaustive extraction, low-novelty digest-only, at matched extraction spend.
  Honest risk: LoCoMo golds often live in low-surprise smalltalk — a flat
  result is a genuine debunk of write-side foveation for this genre.
- **L3 escalation lane** (build candidate): verifier-unsupported / low-coverage
  → fetch the full raw session(s) → one large-context generation. Cost is
  bounded by fire rate; metrics are the cascade's — accuracy vs always-cheap
  and always-expensive bounds, mean cost/question, per-layer fire rates.

Quick wins independent of the program: flip usage recording on the eval stand
(data starts accruing for free); the tenant-aware decay fix; promote
`INSIGHT_TOP_K`/`DIGEST_LIMIT` to profile fields (prereq for per-conversation
budgets).

## 9. The pointer hypothesis (architectural frame, 2026-08-17)

Statement: cognitive capability over a persistent substrate is bounded less by
model intelligence than by the GEOMETRY OF ACCESS — the system of pointers that
decides which part of reality is made computationally available at high
resolution. Memory (facts → pointer → raw window), vision (periphery → pointer
→ fixation), reasoning (hypothesis → pointer → evidence → verification) and
planning (branch → pointer → simulation → commitment) are four surfaces of one
mechanism. The closed loop — substrate → pointer → observation → resolution →
prediction → surprise → new pointer — is a perception-action loop over
persistent reality, not a memory system.

Evidence already on the ledger, re-read through this frame:
- Eleven fixed-geometry interventions (rerankers, prompt rules, model swaps
  both directions) = eleven nulls/negatives. Every large measured effect is an
  access-geometry change: raw-replay (−22pp when absent), dual-trace scene
  anchors (+20.2 published), date-context (+21pp temporal, our interim), and
  the router-off decomposition (−5.4pp traced per-question to POINTER
  machinery: recency markers, preference probe, chronological ordering — same
  model, same substrate, different addressing).
- The cleanest external control: oracle retrieval ≈ 92% on LongMemEval with
  the same model class that memory systems hold at 50-70 — the reasoner was
  never the binding constraint; the presented world was.
- The loop exists in embryo: searchLoop's refineQuery IS surprise → new
  pointer (round-capped). The missing edge is PREDICTION as a read-side
  control signal (surprise currently exists only at write time).

Falsification battery (all already scheduled):
- E1 age-graded serving: no inverted-U ⇒ resolution allocation doesn't matter
  at matched budget — hypothesis weakens materially.
- Search-loop legs: null on the gold-in-window class ⇒ active addressing adds
  nothing over one-shot — the loop's value is disproven for this genre.
- L3 escalation: if the cascade cannot approach full-context accuracy at a
  fraction of its cost, variable resolution is decorative.
- E2 prefetch hit-rate: prediction edge unviable if next-need is
  unpredictable (the sleep-time law's gate).
- E-graph 2×2: distinguishes pointer LOOP value from pointer FIELD structure.

Guardrails on the frame itself: (i) the scaling path is not refuted — it is
priced in as the cascade's top layer (full-context beats memory at ≤130K on
accuracy; pointers decide WHEN to pay for the fully-unfolded picture);
(ii) physical analogies (pointer states / einselection) are decorative, not
load-bearing — no engineering constraint follows from them.

## 10. Multiworld — the ontological-projections verdict (2026-08-20)

Measured trigger: the clean LME confirm (arm B, 48.0 full-500, router +6.8pp
paired) left SSA at 42.9% with "facts do not specify" misses; the SSA
raw-window legs came back NEGATIVE — bundle (episodic+excerpts+raw-window via
legacy 'always') 23.2%, raw-window-ONLY 32.1% vs 42.9 base (flips +2/−8).
Mechanism: raw windows anchor on FACT hits' grounding turns — but SSA's gold
was never extracted into facts (the base deriver contract is user-fact-shaped),
so no fact points near the gold turn and the windows inject off-topic verbatim.
Facts-as-index cannot serve content the index never covered.

Research verdict (ablation-first): **multiplicity pays as multi-VIEW indexing
and TYPED lanes over ONE substrate — not as N independent stores.** A-grade:
MemGAS (4 granularities union: F1 20.38 vs best single 14.94, +36% rel, union
beats single even without the router); LongMemEval design study — facts as
additional index KEYS +9.4% recall, facts as VALUES (replacement) hurt QA
except multi-session — our SSA failure is this finding verbatim (MemIR names
it "provenance-role collapse"); RAPTOR collapsed-tree union across resolutions;
O-Mem persona world +1.6 F1 at MATCHED token budget (persona also acts as a
4× retrieval-length filter). The multi-store flagships (MIRIX 6 types,
Hindsight 4 networks) publish ZERO component ablations. Nobody good pays N×
derive: Hindsight/MemIR/O-Mem all do ONE extraction pass emitting typed atoms.
Contrarians hold the bar: Mastra's single observation log hits 94.6 SSA
because it never projects away role/time/verbatim; Nano-Memory (strong
retrieval over raw turns) beats MemGAS at half cost.

Program implications (priority order):
1. **Multi-pin read** — the one true architectural gap: read a SET of
   (world, budget) pairs with RRF-style union (Hindsight's exact pattern);
   registry already versions worlds, where-builder pins exactly one.
2. **Typed single-pass derive** — one deriver pass emitting atoms tagged
   {fact | assistant_contribution | persona_attr | event} + role + per-turn
   timestamp (delivers the V13 turn-headers fix as a side effect); worlds =
   typed lanes over one atom stream, shared episode_indices to L0.
3. **SSA = role-filtered verbatim lane over L0** (segment granularity +
   denoising per SeCom), registered as a world in the union — no new derive;
   raw-window (as built) is the wrong tool for this class and measured so.
4. **Facts-as-keys**: index L0 segments under extracted fact/time keys so the
   fact world POINTS AT verbatim evidence instead of replacing it.
5. Budgets before routers (always-all-worlds + static budget vector; entropy
   router later); foveation as budgeted drill-down (xMemory), not static
   per-world resolutions.
Guard: every multiworld leg must beat BOTH the current fact world AND a
strong-retrieval-over-L0 baseline at matched tokens.

### §10 build (2026-08-20, branch multiworld-build) — all four items, default-off

- **M1 multi-pin read** — `RETRIEVAL_DERIVED_VERSIONS` (comma list):
  the read path serves the SET of worlds (`derivedVersion INSIDE […]`
  via the extended `derivedVersionFence`; single-element unions
  collapse to the equality form — byte-identical off). The tenant's
  own resolved world (registry live row / `RETRIEVAL_DERIVED_VERSION`)
  is always unioned IN, never displaced (`ReadPinService.resolveRead`
  / `bootstrapRead`). Read surfaces ported: fact legs (where-builder),
  insight leg, digest lane, query-arc. Write/maintenance (derive,
  dreams, compaction, communities) stay single-world by design.
  Budgets-per-world deferred until a second fact world exists to
  measure (fusion arbitrates the union until then).
- **M2 typed single-pass derive** — `DERIVER_TYPED_ATOMS`: the one
  extraction pass tags every proposition `kind ∈ {fact,
  assistant_contribution, persona_attr, event}` (schema enum + prompt
  section; subsumes DERIVER_ASSISTANT_CONTENT), stamped as
  `source.kind` (FLEXIBLE ride, off-enum dropped —
  `TYPED_ATOM_KINDS` is the one vocabulary for prompt, schema and
  stamp). Fresh derivedVersion required.
- **M3 assistant verbatim lane** — `RETRIEVAL_ASSISTANT_LANE`
  (+`_TOPK` 6, +`_MATCH` 'assistant'): BM25 over L0 restricted by
  case-insensitive speaker SUFFIX (harness speakers are
  `<slug>__<role>`), own transcript-slot lane, measurable on the
  default profile. Empty for corpora without the role (LoCoMo inert).
- **M4 facts-as-keys** — `RETRIEVAL_FACTS_AS_KEYS` (+`_CAP` 8): the
  top evidence fact lines carry ONE verbatim grounding-turn quote
  (` [source YYYY-MM-DD speaker: "…"]`, 240-char cap) via the
  updateStories suffix mechanic (`applyFactSuffixes`) — fact = key,
  raw turn = content; both prompts read the same lines.

Measure order (cheapest decisive first): (1) SSA leg with M3 on the
existing wd-v2 worlds (`--skip-ingest`, offset 444, 56 q) vs the 42.9
armB base — the direct test of the §10 mechanism; (2) M4 on the
temporal+MS block (the raw-replay −22pp class, same worlds); (3) M2
fresh mini-derive + M1 union {wd-v2, typed world} vs each alone —
the multi-pin experiment proper; run the strong-retrieval-over-L0
contrarian baseline beside every positive before believing it.

### §10 measured (2026-08-21) — the SSA ladder is CLOSED

All legs: SSA block (offset 444, 56 q), config identical to arm B
except the named lever; paired flips vs the 42.9% arm B base.

| leg | SSA | flips vs base | verdict |
|---|---|---|---|
| raw-window bundle (V13) | 23.2 | — | negative (facts-as-anchor can't reach unextracted gold) |
| raw-window only | 32.1 | +2/−8 | negative |
| M3 lane v1 (role-filtered BM25) | 46.4 | +2/−0 | small plus, absence-class collapsed (2/30) |
| M3 v1.1 exchange granularity | 44.6 | +1/−0 (vs v1: +0/−1) | null → reverted; residual = BM25 RANK, not anchor side |
| **M2 typed world wd-mw1** | **57.1** | **+14/−6** (χ²=2.45) | **the §10 mechanism confirmed: assistant content as EMBEDDED facts (dense retrieval) is the fix** |
| M2 + M3 lane combo | 55.4 | +12/−5 (vs mw1: +1/−2) | lane subsumed by the typed world — no stack |

Verdict: SSA is a CONSTRUCTION-side class (same law as temporal §1) —
`DERIVER_TYPED_ATOMS` on the derive closes it; read-side verbatim lanes
only patch untyped worlds (+3.5) and add nothing over a typed one.
M1 union of {wd-v2, wd-mw1} is NOT the union experiment — wd-mw1
subsumes wd-v2's contract (duplicate-snapshot anti-pattern, see the
key's constraint); the union pair needs complementary worlds. The 56
typed SSA worlds derived clean (56/56 ok, ~590 props/world, ~6.3
min/world, ≈$2).

**Statistical honesty (owner call 2026-08-21, program PARKED):** the
headline SSA flip count (+14/−6) is exact-binomial p≈0.06 one-sided —
a strong DIRECTION with a mechanism-coherent 5-arm ladder, NOT a
confirmed effect (the V8 lesson: an n≈40-56 series carries ±10pp of
noise; the V4 temporal bank died on re-derive once already). Same for
tm-pack (+6/−1, p≈0.06). The temporal 2×2 is 2/4 cells: wd-mw2 worlds
are derived and PAID FOR (133/133 ok) but the two remaining legs
(~$3) are deliberately not run. The one decision-grade experiment,
if/when the owner wants it: ONE full-500 shot on a fresh combined
write-pack derive (typed-atoms + time-pack, new version) vs arm B —
~$20-25 — which confirms or kills both construction-side effects at
n=500 in a single paired measurement instead of per-axis dribbles.

### §10 literature update (2026-08-22) — the parked direction gains independent support

Three papers landed on the exact shape the ladder measured:

- **MemIR (arXiv 2605.25869)** names our SSA failure mode outright —
  **"provenance-role collapse"** — and its fix is a three-way
  separation of *raw evidence / retrieval cues / truth-bearing
  claims*: memories that anchor retrieval are not the same objects as
  memories that answer, and both must keep a pointer to the evidence
  they came from. That is our typed-atoms design (M2 `kind` tags over
  one substrate, facts-as-keys pointing at verbatim turns) stated as
  the paper's central mechanism rather than a passing label.
- **Eywa (arXiv 2605.30771)** — "**evidence before belief**": raw
  observations are stored first-class and beliefs are derived views
  over them, with a **deterministic zero-LLM read path** over the
  evidence store. That is our episode substrate → derived-worlds
  architecture (immutable L0, versioned derivations, LLM-free
  ingest). Their benchmark numbers remain non-comparable (self-run
  in-house suite — see the eval-protocol caveat); the support here is
  architectural, not numeric.
- **ScrubJay-MEM (arXiv 2608.04746)** adds **per-type perishability**:
  memory types decay on different clocks (preferences drift, events
  don't, identity facts persist). For us this is a concrete NEXT lever
  that only exists *because* atoms are typed — type-conditioned
  temporal decay over the M2 `kind` vocabulary (a principled successor
  to the fovea program's salience-decay interest, this time with a
  published mechanism rather than vendor prose).

Frame: the parked SSA 57.1-vs-42.9 direction (p≈0.06, direction not
effect) now has independent literature support from three unrelated
groups converging on typed atoms over one evidence substrate. The
decision bar is unchanged — the recorded next step remains the ONE
decision-grade full-500 combined write-pack confirm (~$20-25) above;
the literature moves the prior, not the statistics.

## 11. Genre presets (built 2026-08-21, branch feat/genre-presets)

The measured genre-dependence of the engine is now a PRESET LAYER
(`src/search/genre-presets.ts`): each `RetrievalGenre` ships tuned
defaults for the measured levers, and explicit configuration always
wins. This is the §6 platform posture made concrete — "per-genre
configuration, not removal; the segment-lane precedent: genre-dependent
sign, resolved by profile".

### Precedence contract (strict, resolved per field)

```
per-company overlay field  >  explicit env key  >  genre preset  >  code default
```

- A preset value applies ONLY where the corresponding env key is unset.
  An explicitly SET key — including an explicit `0` on a boolean — is
  the operator's word and beats the preset in both directions
  (`presetFlag` checks unset before parsing, because `envFlagEnabled`
  cannot tell unset from `0`).
- Legacy keys keep their historical explicitness: the per-lane verbatim
  flags imply `'always'` only when one of them is ENABLED (their falsy
  state defers to the preset); `SYNTHESIZE_DATE_CONTEXT` set to ANY
  value — including the measured LoCoMo pin `=0` — is explicit and
  beats the preset.
- When a company overlay changes `genre` itself,
  `resolveRetrievalProfileFor` resolves the overlay genre FIRST,
  re-derives the preset-backed base for THAT genre, then applies the
  remaining overlay fields on top.
- Preset-INELIGIBLE by design: `genre`, `lanes`, numeric caps/budgets,
  string knobs (`verifierModel`, `assistantLaneMatch`), and the infra
  execution modes (`coverageScanMode`/`coverageLexMode`/`scanHnsw*` —
  per-tenant enable rituals, never genre semantics).

### Preset table (evidence-pinned; inclusion needs a measured on-genre positive and no on-genre negative)

| genre | lever | preset | evidence |
|---|---|---|---|
| dialogue | `verbatimEvidence` | `'always'` | Genre law, measured twice (`typed-answer-dispatch-2026-07.md` §3): segment lane **+3.8pp LoCoMo** two-human dialogue; `'always'` = the diary-genre profile (the old lane flags ON) |
| dialogue | `dateAnchoring` | `'none'` | Date context **−7.1pp on LoCoMo** by gold convention (`typed-answer-dispatch-2026-07.md` §3); "LoCoMo-convention eval profiles must pin =0" (`measure-ladder-2026-08-results.md` E2); armK guard: session-date defaults ARE the LoCoMo answer convention (§5 above) |
| assistant_chat | `sceneTraces` | `true` | Dual-trace scene anchors **+20.2pp LongMemEval-S** (95% CI +12.1..+29.3; temporal +40pp, KU +25pp, MS +30pp) in the controlled pair (§5 B10 + §7). Read-side render only — byte-identical against worlds derived without `DERIVER_SCENE_TRACE` |
| assistant_chat | `abstentionCalibration` | `'verifier'` | The V9 verdict-decline win: **+17.5pp** on the abstention row, BEAM first-person assistant chats (`v10-audit-2026-08.md`; "our 'verifier' arm at 0.85 is competitive with anything published"). Zero marginal model calls — the verifier already runs in lenient guardrails; `'answer'` guardrails stay exempt |
| documents | — | *(empty)* | The axis is unmeasured — "we have NO non-conversational eval axis" (§6). Pure code defaults until a documents-genre eval exists |

The segment-lane law is respected in BOTH directions: `'always'` is
preset for dialogue only; assistant_chat keeps `shape_conditioned`
(segment lane −28pp LongMemEval / −18.6pp BEAM, `typed-answer-dispatch-2026-07.md` §3).

### Deliberately left out (evidence says no, or not yet)

- **Digest evidence / digest lanes** — the +5.0 strict is BEAM-measured
  WITH a recorded conflicting negative on the same benchmark
  (abstention −7.5, summ nugget −1.9 lane bleed, §5 B7); the
  `summary_ku` gate that should fix the bleed is built but unmeasured
  (§2 item 0.4). Also inert without `DERIVER_DIGEST` worlds.
- **Raw window** — measured NEGATIVE on assistant_chat SSA (23.2/32.1
  vs 42.9 base, §10); facts-as-anchor cannot reach unextracted gold.
- **Assistant lane / facts-as-keys (multiworld M3/M4)** — program
  PARKED for statistical honesty (§10: p≈0.06 direction, not a
  confirmed effect).
- **V13 read levers** (`timeFilter`, `dateMath`, `answerConditioning`,
  `noiseFilter`, `searchLoop`) — built default-off with expectations,
  not measurements (§5 B3-B8); LoCoMo read-side is explicitly "not
  worth chasing" (§2: six nulls, ±2.2pp floor).
- **`temporalMode='overlap_boost'`** — measured +1.6 n.s. only; no
  recorded positive in the pinned docs.
- **`verifierModel='gpt-5-mini'`** — direction-positive at n=40, the
  default-on decision explicitly awaits the n≥120 confirm (§2 item 0.2).
- **`verbatimEvidence='fused'/'routed'` for dialogue** — LoCoMo +1.4pp
  sits outside the pinned doc set and next to a pooled −5.0pp with only
  the verbatim-shaped class winning (validate-2026-08 V6 pairs); the
  dispatch stays an explicit per-tenant choice.

Unit pins: `test/genre-presets.unit-spec.ts` (precedence matrix +
full-effective-profile snapshot per genre, so any future preset edit is
a visible diff). Note the default-genre behavior change this ships:
`assistant_chat` (the boot default) now resolves
`abstentionCalibration='verifier'` and `sceneTraces=true` unless env
says otherwise; `RETRIEVAL_ABSTENTION_CALIBRATION=off` restores the
legacy lenient contract.
