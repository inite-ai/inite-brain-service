# Typed Answer Dispatch (TAD) — the road past one-size-fits-all QA

Written 2026-07-31, after the first funded runs of all three eval axes
(LoCoMo E16 78.7% held-out; LongMemEval-S partial-259 56.4%; BEAM-100K
31.1%) and a three-agent research round. Status: design + evidence;
implementation staged behind flags, one measured leg per lane.

## 1. The finding that forces the design

Per-question failure analysis across all three axes decomposes almost
every miss into SIX typed deficits — and each maps 1:1 onto a read
surface the brain ALREADY exposes but the one-shot QA path never uses:

| # | Deficit (evidence) | Existing surface | Non-LLM core of the fix |
|---|---|---|---|
| T1 | Temporal distance: right date found, wrong arithmetic vs "today" (LME temporal 30.8%: "Nov 17, 2022 … was 46 weeks ago" — true answer 2) | `SYNTHESIZE_DATE_CONTEXT` + timeline | date math computed in code, not by the LLM |
| T2 | Enumeration/ordering: partial lists (LME multi-session 51.2%: "4 of 5 model kits"; LoCoMo multi-hop 63.6: "Canada" without "Greenland"; BEAM event_ordering 0%) | timeline enumerator (AGENT_QA_TOOLS_V2), aggregates | exhaustive validFrom-sorted scan; count/order in code |
| T3 | Contradiction report: we confidently answer ONE side; gold = "you said both X and Y — which is correct?" (BEAM contradiction 0%) | `get_competing_facts` / `detect_contradiction` | bitemporal store retains BOTH sides; render both with provenance |
| T4 | Preference conditioning: generic recommendations ignoring stored prefs (LME preference 43.3%) | profile preferences aspect | verbatim injection of stored preferences |
| T5 | Stale-value answers: "65%" when updated to "78%" (BEAM knowledge_update misses) | bitemporal supersession | deterministic max(validFrom) among same-slot competitors |
| T6 | Progressive summary: one fact instead of a staged narrative (BEAM summarization 18%) | `summarize_entity`, aspect rollups | chronological aspect-wide assembly budget |

Abstention needed no lane at all: the "collapse" was a harness scoring
bug (the shared regex missed the guardrail sentinel). True rates:
LME `_abs` 17/18 (94%), BEAM B1 22/40.

## 2. External evidence (research round, 2026-07-31)

- **Feasibility is proven on LongMemEval itself.** AgentIR (arXiv
  2605.25092): a TF-IDF+LR question-type router (79.6% accuracy, ~470µs)
  discretely routing to per-type-best retrieval channels MATCHES the
  ground-truth-type oracle; OMEGA (#1 on LME at 95.4%) routes to five
  category-specific answer prompts; Eywa uses a deterministic zero-LLM
  shape planner with per-shape channel weights. Write-side typing is
  separately validated (ENGRAM: collapsing typed stores −31pp). What NO
  system does: dispatch to deterministic programs over a bitemporal
  store — the contradiction-report and ordering lanes have no
  published equivalent.
- **Per-type ceilings are demonstrated, not speculative**: TR 31.6→86-95
  (Mastra write-time date resolution 95.5; TSM temporal-KG 69.9 with
  4o-mini; JSON+timestamp-sorted+compute-then-answer reader worth +10pp
  at oracle retrieval); MS 51→84-87 (exhaustive enumeration for counting
  + entity-expanded recall breadth); SSP→100 (pref extraction + answer
  policy); KU→96 (one-active-fact-per-slot supersession — Eywa). Known
  risk to design around: user-fact extractors REGRESS single-session-
  assistant (Zep −17.7pp; Mem0 26.8%) — our deriver must keep
  attributing assistant-side content.
- **The biggest documented per-type gain is exactly our T1**: TReMu
  (arXiv 2502.01630) 29.8→77.7 on temporal QA via timeline memory +
  Python date arithmetic. Non-LLM work is where lanes buy accuracy;
  "same retrieval, different prompt" buys only efficiency (AdaRankLLM).
- **T4 has a named winning program**: PrefEval (ICLR 2025) — verbatim
  "reminder" injection of stored preferences beats CoT and self-critique.
- **T3 is an open problem of the field**: LIGHT (BEAM's own system)
  never exceeds 0.042 on contradiction_resolution at any tier — its
  scratchpad compressor literally instructs "eliminate older values",
  destroying one side of every contradiction. Our bitemporal substrate
  keeps both sides; 2026 literature (arXiv 2604.11364) cites BEAM's
  contradiction zeros as "the missing knowledge layer". Moving 0→30-50%
  here is a field-level differentiator, not a tweak.
- **Routing is cheap**: lexical rules beat embedding routers
  (RAGRouter-Bench: TF-IDF+SVM 93.2%); routing pays even at 54% router
  accuracy when misroutes fail open to the generic lane (Adaptive-RAG);
  no LLM on the hot path (MemRouter: 12M-param head beats LLM manager
  at 17× lower latency).
- **Escalation, not agency**: bounded 2-3 step loop with explicit
  evidence-gap state (MemR³ +7.3%); free ReAct loops lose (our own E11
  −4.6pp p=0.002; overthinking/tail-latency literature concurs).
- **Context**: our BEAM-100K 31.1% (after the genre fix) already sits
  inside LIGHT's own 100K band (0.294–0.358 across backbones) — with a
  generic path. The typed lanes attack abilities LIGHT structurally
  cannot.

## 3. Genre law (measured twice, now part of the design)

`SEARCH_SEGMENT_LANE_ENABLED` is corpus-genre-dependent: +3.8pp on
LoCoMo (two-human third-person dialogue), −28pp on LongMemEval and
−18.6pp on BEAM (first-person user↔assistant chats, verbatim segments
trigger conversation-continuation bleed). Same family: date-context
(−7.1pp LoCoMo by gold convention; required for true date arithmetic on
LME). The dispatcher therefore has TWO axes: question-type lane
selection AND corpus-genre flag profile per tenant/vertical.

## 4. Design

```
question ──► Stage A: lexical rules (free)  ──┐
             Stage B: tiny classifier head    ├─► lane ∈ {T1..T6} above
             (frozen embedder + LR, optional) │    per-lane precision
             fail-open ────────────────────────┘    threshold, else ↓
                                              generic union-retrieval
                                              + synthesis (today's path)
                    low-confidence / evidence-gap
                    └──► bounded escalation loop (≤3 steps, masked
                         retrieval, existing AGENT_QA_ROUTE_MODE rails)
```

Each lane = existing surface + deterministic non-LLM core + type-shaped
answer instruction. No new memory layers. No new agents. Flags per
lane, default off, one measured leg each (paired McNemar, benchmark
type labels give free oracle-headroom measurement per lane BEFORE
building it).

## 5. Measurement plan (cheap: saved worlds re-QA)

BEAM's 20 worlds are intact in the stand — every lane leg is a re-QA
(~$1-2). LME worlds are re-derivable (episode-only ingest is LLM-free;
~$2/50 worlds). Order by expected-value-per-dollar:

1. **T1 temporal** (LME temporal 31%→target 65-85; TReMu 29.8→77.7 and
   TSM 69.9@4o-mini precedents) — date-context + timestamp-sorted
   evidence + compute-then-answer arithmetic in code. Our substrate
   already stores occurred_on/validFrom absolutes (Mastra's most-credited
   technique) — the deficit is purely read-side.
2. **T2 enumeration** (LME multi-session 51%→65+; BEAM event_ordering
   0%→25+) — timeline enumerator as one-shot lane, order/count in code.
3. **T3 contradiction** (BEAM 0%→30+) — competing-facts report program.
4. **T5 update arbitration** (BEAM knowledge_update 45%→60+) —
   max(validFrom) slot arbitration at read.
5. **T4 preference** (LME preference 43%→65+) — verbatim pref injection.
6. **T6 summarization** (BEAM 18%→35+) — aspect-wide chronological
   assembly.

Gate for the program: headline deltas on held-out slices with paired
stats; per-lane regressions on the OTHER axes (a lane must not damage
LoCoMo — genre profiles keep LoCoMo's winning config frozen).

## 6. Explicitly rejected

- Free agentic loop as the primary path (E11 −4.6pp; literature).
- LLM router on the hot path (latency; lexical rules measurably better).
- New memory layer / rewrite of stores (all six lanes ride existing
  substrate; ENGRAM's write-typing insight is already partially covered
  by aspect slugs and is a separate, later bet).
