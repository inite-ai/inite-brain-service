# Brain — SOTA memory architecture for conversational QA (v2, 2026-07-24)

Extends and partially supersedes `locomo-architecture-optimization.md` (written at the
24.3%/1-sample era; its Tier 0 — never-abstain contract, multi-sample, per-category —
is done). This doc adds three things the prior pass did not have: a **corrected
category mapping**, an **empirical failure decomposition against the live fact store**,
and a **2026 matched-protocol SOTA landscape**. Together they change the priority order.

Current baseline (dev-5, gpt-4o-mini answer + gpt-4.1-mini judge, cats 1-4):
**53.8%** (control A) / 54.5% (occlusion B) vs **69.3%** full-context.

## 1. The category labels were shifted — every per-category conclusion predates this fix

`run-locomo.ts` / `locomo-compare.ts` / `locomo-fullcontext-baseline.ts` labeled
categories `{1: single-hop, 2: multi-hop, 3: temporal, 4: open-domain}`. The dataset's
actual convention (verified by sampling questions per id) is:

**`{1: multi-hop, 2: temporal, 3: open-domain, 4: single-hop, 5: adversarial}`** — fixed 2026-07-24.

Corrected dev-5 profile (leg A vs our own full-context):

| true category | n | FC | ours | gap |
|---|---|---|---|---|
| single-hop | 418 | 89.2% | 59.3% | **−29.9pp** |
| multi-hop | 142 | 49.3% | 33.1% | **−16.2pp** |
| temporal | 156 | 47.4% | 62.2% | **+14.7pp — we beat FC** |
| open-domain | 46 | 23.9% | 39.1% | +15.2pp (n small) |

Consequences:
- The headline gap ≈ entirely single-hop: 0.55 × 29.9 ≈ 16pp of the 15.5pp total.
- **Temporal is a confirmed strength, not the weak spot** the prior roadmap assumed.
  Bitemporal fields + occurred-on + validity rendering already work. Protect it; the
  `nooccur` ablation must be re-run (its report is invalid — DB died mid-run, 23% dead answers).
- Prior-session conclusion "we lose open-domain 54 vs 89" was actually "we lose
  **single-hop** 54 vs 89".

## 2. Failure decomposition (leg A wrong answers × live DB, 6,723 active facts)

For every wrong answer, token-matched the gold against all active fact objects/dates/
entity names (`FOUND` = gold-bearing fact exists; optimistic upper bound):

| true category | wrong n | gold FOUND in facts | gold ABSENT |
|---|---|---|---|
| single-hop | 170 | **72%** | 28% |
| multi-hop | 95 | 57% | 39% (mostly enumeration golds needing aggregation) |
| temporal | 59 | 75% | 24% |
| open-domain | 28 | 25% | 75% (speculative golds — not lookups) |

Second split, single-hop wrong answers by prediction style: **91% are confident wrong
specifics**, only 6% "facts do not specify", 3% empty.

Diagnosis: the dominant failure is **read-path fact selection** — the right fact exists
but a near-miss neighbour wins, or the surfaced fact is an unresolved fragment
("moved from *her home country*" while "Sweden" sits in a different fact). Extraction
lossiness is real (28-39% ABSENT: unextracted list items, unresolved antecedents) but
secondary. This inverts the Phase-4 "fix recall in extraction" priority.

Structural read-path findings (file anchors in the audit transcripts):
- **Synthesis discards hop evidence**: `maybeSynthesize` re-runs a fresh search with the
  original question anchored to `entityIds ⊆` the ≤10 final entities. If the gold entity
  missed hop-1's top-10, the answer is unreachable *by construction*. Hop
  `supportingFactIds` are collected and then never used.
- **Question↔fact embedding asymmetry has zero mitigation in the corpus**: facts embed as
  `predicate: object`; HyPE `altEmbedding` = 0 rows; sentence-embedding was reverted
  (−2.9pp, constant-subject collapse); contextual stamp off. BM25 carries the recall.
- `candidateK = min(limit·5, 200)` = 50 per leg; entity top-10 gate; per-entity fact cap.
- Multi-hop planner ships a hard-coded 12-predicate CRM vocabulary alien to the coined
  open predicates (3,644 predicates / 6,153 facts, 81.5% singletons).
- No raw-turn store exists at all — extraction misses are unrecoverable at read time.

## 3. SOTA landscape (matched protocol: gpt-4o-mini answer, 4o(-mini)-class judge, cats 1-4)

Full table + sources in the research transcript; the load-bearing rows:

| system | single-hop | multi-hop | temporal | overall | note |
|---|---|---|---|---|---|
| ours (A) | 59.3 | 33.1 | 62.2 | 53.8 | |
| Mem0 | 67.1 | 51.2 | 55.5 | 66.9 | paper |
| Memobase | 70.9 | 46.9 | **85.1** | 75.8 | timestamped event store |
| **ENGRAM** | 79.9 | **79.8** | 70.8 | **77.6** | typed stores, ~916 evidence tokens, beats FC |
| full-context | — | — | — | 72.6-72.9 | this protocol's ceiling |
| Letta files+grep | — | — | — | 74.0 | lossless substrate + agent loop |

Protocol effects dominate marketing numbers: FC alone jumps 72.6 → 87.5 swapping the
answer model to gpt-4.1-mini; several vendor 90%+ claims failed independent
reproduction (details + citations in the research transcript). LoCoMo's answer key is
~6.4% wrong (practical ceiling ≈ 93.6%); dev-5 deltas under ~5pp are noise.

Key transferable evidence:
- **ENGRAM ablation**: collapsing typed stores (episodic/semantic/procedural) into one
  undifferentiated ranking drops 77.6 → 46.6 — the largest published LoCoMo ablation.
  Our single hybrid ranking over extracted facts IS the collapsed anti-pattern.
- **Letta 74.0 with raw files + grep**: a lossless episodic substrate with iterative
  search out-scores most extraction pipelines. Extraction must beat this to justify itself.
- **MIRIX multi-hop 83.7 > its FC 77.7** via write-time consolidation: store the
  *composed* cross-session event, don't stitch at query time.
- **Memobase temporal 85.1** via explicit timestamps on chronologically-ordered events —
  we already half-have this (and beat FC); polish, don't rebuild.

## 4. Target architecture: three typed lanes + write-time composition

The redesign principle: **stop making one ranking do four jobs**. Retrieval becomes a
typed union with a fixed evidence budget; write-time compute pre-answers composition;
raw dialogue becomes a first-class fallback lane.

```
                    ┌─ Lane E: EPISODIC (new) ──────────────────────┐
 ingest turn ──────►│ dialogue_turn: {conv, session, speaker, text, │
      │             │ occurredAt, embedding, BM25 haystack}          │
      │             └───────────────────────────────────────────────┘
      ├─ extract ──► Lane S: SEMANTIC facts (existing, + fact-centric read path)
      │             entity graph + coined predicates + bitemporal
      │
      └─ consolidate/recompose (existing rails) ──► Lane C: COMPOSED (new use)
                    composed events + per-(entity, predicate-family) aggregates,
                    derivedFrom lineage, staleness-cascade kept fresh

 read:  per-lane top-k (hybrid dense+BM25+entity-exact) → typed, budgeted union
        (≈25 items / ≈2k tokens, per-speaker banks, episodic chronologically sorted)
        → synthesis consumes THIS union (hop evidence included; no re-search anchor)
```

**Lane E — episodic substrate (biggest addition).** Store every raw turn with speaker +
date + embedding + BM25. No LLM at write. Retrieval lane returns dated quotes. Directly
attacks: the 28% ABSENT single-hop failures, fragment-objects (the raw turn contains
"Sweden"), and the Letta baseline. The 07-19 "episodic quotes distract" negative result
predates the never-abstain contract and used quotes as garnish on top of fact context —
ENGRAM's evidence says the lane works when *typed and budgeted*, not appended.

**Lane S — semantic facts, read path fixed.** (a) Fact-centric ranking parallel to
entity buckets so facts, not entities, compete for synthesis slots (occlusion selector
already provides fact-level dedup for this lane); (b) synthesis consumes the retrieved
union incl. hop `supportingFactIds` — the entity-anchored re-search ceiling goes away;
(c) embedding bridge for the question↔statement gap: contextual stamp re-ingest and/or
HyPE `altEmbedding` backfill (both flags exist; corpus has neither).

**Lane C — composed events + aggregates (MIRIX move on our rails).** Extend
`consolidate.service` beyond dedup/supersede: when cross-session facts link the same
entity, write the composed event ("C and M attended a pride festival together, 2022")
as a retrievable fact with `derivedFrom`. Add per-(entity, predicate-family) aggregate
facts ("activities: pottery, painting, camping, hiking…") — enumeration golds are 39%
of multi-hop misses. `mark_derived_stale` (0072) + recompose keep both fresh — this is
the cascade-recompose machinery finding its consumer.

**Synthesis contract.** Typed sections in the prompt (`facts / events / quotes`),
episodic evidence in chronological order, current-date + date-arithmetic instruction,
evidence budget ≈2k tokens. Temporal rendering stays as-is (it wins).

## 5. Phasing (each flag-gated, measured on dev-5 corrected labels; <5pp = noise)

- **Phase A — read path only, no re-ingest.** Synthesis consumes hop facts; fact-centric
  lane; typed prompt sections + chronological ordering + date instruction. Cheapest,
  targets the 72%-FOUND failure mass.
- **Phase B — episodic lane.** `dialogue_turn` table + hybrid lane + budgeted union.
  Re-ingest cost: embeddings only.
- **Phase C — write-time compute.** Composed events + aggregates on consolidate/recompose;
  contextual-stamp re-ingest; optional HyPE backfill.
- **Eval reform alongside**: adopt LoCoMo-Refined strict judge as a second axis; keep
  cat-5 exclusion; report evidence-token budget next to accuracy; re-run the spoiled
  `nooccur` ablation before concluding anything about occurred-on.

Realistic target per the matched-protocol evidence: ENGRAM-class typed architecture
reaches **high-60s/low-70s with our exact answer model** — above our own 69.3
full-context ceiling — without touching the answer model. Guardrail: temporal (+14.7)
and the KG multi-hop machinery must not regress; any lane change is A/B'd per category.

## Sources

MIRIX arXiv:2507.07957 · ENGRAM arXiv:2511.12960 · CogniFold arXiv:2605.13438 (cross-system
matched table) · Mem0 arXiv:2504.19413 · Zep arXiv:2501.13956 (+ rebuttal thread) ·
Memobase locomo-benchmark repo · TRACE arXiv:2607.00339 · Letta filesystem-agent blog ·
Mastra Observational Memory · Penfield LoCoMo audit (6.4% wrong key) · LoCoMo-Refined
(strict judge, 1,382-question cleaned set) · full citation list in the 2026-07-24
research transcript.
