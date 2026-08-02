# Next session: research + fix BEAM (typed-dispatch round 2)

## STATUS 2026-07-31 (build session): ALL BUILD ITEMS DONE, unmeasured

Commits a2b9dfb..d902b3b, everything flag-gated default-off. Built:
per-lane ablation `SYNTHESIZE_LANES_DISABLED=t1..t7`; T1b interval
table `SYNTHESIZE_TEMPORAL_EVENT_INTERVALS` + `--asof-policy none`
(research: BEAM golds are event-to-event, NO question date exists —
rubrics expect "N units, from D1 till D2"); T2b first-mention
enumerator `SYNTHESIZE_ORDERING_FIRST_MENTION` (mention date =
earliest grounding episode, NOT validFrom which is the event date;
reported metric is tau_norm over the newline-split response); T6/T2
wide probe `SYNTHESIZE_LANE_WIDE_PROBE`; T7 instruction lane
`SYNTHESIZE_INSTRUCTION_LANE` (live probe: instructions ARE captured
as preference facts, surface at position 33/40 — application, not
extraction, is the gap); `--nugget-judge` official scoring with their
two bugs fixed (int(0.5)→0, unsubstituted <question>). Research
reports: BEAM repo conventions, Eywa (their "BEAM" is in-house, NOT
comparable), CR positioning table (now in docs/eval-protocol.md),
LIGHT scratchpad mechanics. NEXT: measure — one flag per leg, same
worlds, contradiction must not regress; restart brain per leg.

State on entry (2026-07-31): BEAM-100K worlds intact in the stand
(cheap re-QA ~$1-2/leg, --skip-ingest). Configs measured, paired on the
same worlds: v1 12.5% (lane-on) → B1 31.1% (lane-off) → router-v1 34.2%
→ router-v2 surgery (3676f13). Contradiction_resolution 0→52-55% held
across two legs — the field's open problem (LIGHT ≤4.2%) moved; keep it
intact in every future leg. LME-500 completion may still be running
(checkpoint var/lme500.ckpt.jsonl; self-healing pipeline logs
lme500-pipeline2.log) — read its temporal/KU per-type numbers FIRST:
they are the true T1/T5 test on real question dates.

## LME-500 FINAL (2026-08-02, router-ON leg, 500/500, errors=0)

judgeAccuracy **50.2%** (n=470 answerable), abstention declined 23.3%
(n=30, 'answer' guardrails force answering by design), avg prompt
4,714 tokens (~4% of full context). Report: var/lme-500-final.json;
checkpoint var/lme500.ckpt.jsonl. Config: SYNTHESIZE_ANSWER_ROUTER=1,
segment-lane OFF, NO date-context — not comparable to the LME-50
lane-off 80.0 (different subset AND config).

| type | n | acc |
| --- | --- | --- |
| single-session-user | 64 | 82.8% |
| knowledge-update | 72 | **63.9%** — T5 recency marker holds on real dates |
| single-session-assistant | 56 | 55.4% |
| multi-session | 121 | 51.2% |
| single-session-preference | 30 | 43.3% |
| temporal-reasoning | 127 | **24.4%** — full diagnosis below, fixes built |

Leg by-catch: multi-hop planner asOf 500-bug (e4fb0d7, fixed; q417
answered correctly after), pipeline wedge mode (Surreal OOM mid-pass
hangs the runner past self-heal — watchdog pattern in memory), macOS
purged /tmp during a 28h machine sleep (dataset lives at HF
xiaowu0162/longmemeval, file `longmemeval_s`, no extension).

Next LME leg (one variable each): (1) SYNTHESIZE_DATE_CONTEXT=1 in
env; (2) SYNTHESIZE_ROUTER_LEXICON_V2=1; (3)
SYNTHESIZE_TEMPORAL_EVENT_INTERVALS=1. Temporal decomposition says
those three address 19.2%-unrouted-no-anchor, lexicon misses, and
event-to-event misdirection respectively.

## LME-500 temporal diagnosis (2026-08-01, trace-verified live)

At 330/500 judged, temporal-reasoning runs 29.9% (97 judged) and the
router split settles the T1 question on real dates:

- ROUTED 54: 29.6%. Replayed a failing routed question with
  X-Brain-Debug on its still-live tenant: an EVENT-TO-EVENT question
  ("how many days passed since I bought X when Y happened", gold 14)
  answered 24 — read straight off "[elapsed: 24 days before today]" on
  the buy fact, exactly as the T1 frame instructs. LME temporal is a
  MIX of distance-to-today and event-to-event; the distance frame
  actively misleads the second kind. Fix = the already-built
  SYNTHESIZE_TEMPORAL_EVENT_INTERVALS pair table; next leg should
  route the two shapes to different frames.
- UNROUTED 55: 25.5%. Lexicon gaps, fixed behind
  SYNTHESIZE_ROUTER_LEXICON_V2 (d167c9c): first-person perfect "how
  long have/had I been", "what is the order of…". Additionally the
  leg env carries NO SYNTHESIZE_DATE_CONTEXT, so unrouted
  relative-date questions ("last Saturday") answer with no anchor at
  all — next LME leg env should set it.

## Ranked BEAM deficits, with diagnoses from our own legs

1. **temporal_reasoning 28-48%** — two confirmed causes:
   (a) harness asOf is synthetic (beamQuestionDateIso = last session
   +7d), so distance-to-today is wrong by construction on BEAM;
   (b) BEAM asks event-to-event intervals, not distance-to-today.
   RESEARCH: read BEAM's question-generation prompts/eval code (repo
   mohammadtavakoli78/BEAM, src/prompts.py — a prior agent extracted
   fragments) to learn the temporal gold convention (anchored to what
   date?). BUILD: T1b event-interval program — for routed
   between/since-event questions, render a small pairwise date-diff
   table over the dated facts (computed in code) instead of
   distance-to-today annotations; per-benchmark asOf policy in the
   harness (drop the fabricated +7d if golds are event-anchored).
2. **event_ordering 0-2%** — scoring is Kendall τ × F1 over an
   exhaustive ORDERED list of topic introductions. T2's chronological
   facts are not enough: the asked unit is "order in which ASPECTS were
   brought up". BUILD: first-mention enumerator — group evidence facts
   by aspect, take min(validFrom) per aspect, emit the ordered aspect
   list; deterministic, rides existing aspect slugs.
3. **summarization 18% (T6 null: 18→18)** — render frame alone did not
   move it; the top-K fact budget cannot cover a whole-project
   narrative. BUILD: summary lane must widen retrieval (aspect-wide
   scan / aggregates / summarize_entity-style rollup), not just re-sort.
4. **multi_session_reasoning 35% (T2 null on BEAM)** — same lesson:
   render-only ≠ recall breadth. Candidates: PRF/entity-expanded second
   probe (like T4's), higher candidate budget for enumeration lane.
5. **knowledge_update residual (40 vs 45 at B1)** — decompose T3-vs-T5
   blame. BUILD FIRST: per-lane disable env (e.g.
   SYNTHESIZE_LANES_DISABLED=t3,t5) — one flag per ablation leg is the
   protocol anyway; current all-or-nothing flag can't isolate.
6. **instruction_following ~35-40%** — untouched. RESEARCH: how LIGHT's
   scratchpad USER INSTRUCTIONS section earns its keep; check whether
   our substrate captures standing instructions as facts at all (probe a
   world), then decide extract-vs-lane.
7. **Judge comparability** — BEAM official scoring is per-nugget
   GPT-4.1-mini with partial credit (their repo truncates 0.5→0 via
   int(); we can implement the nugget judge CORRECTLY in our harness)
   → numbers comparable to the paper's tables while keeping our strict
   binary as the headline. Medium effort, high sharing value (Synthius).

## Research items (agents, free)

- BEAM temporal gold convention (question-gen prompts; what "N days
  ago/since" anchors to).
- Eywa (arXiv 2605.30771): 81.45% mean nugget on a BEAM subset with
  deterministic LLM-free retrieval + "evidence before belief" —
  closest published system to our substrate philosophy; extract its
  per-ability mechanics (raw-episode rescue channels, answer_
  instructions separation, validity windows).
- Exabase M-1 press claims (76.9% @100K) — anything reproducible?
- Follow-ups citing BEAM contradiction zeros (2604.11364 lineage) —
  position our 52% result; consider a short writeup for the Synthius
  protocol doc.

## Protocol reminders

- Same worlds, paired McNemar, one variable per leg; contradiction lane
  must not regress in any leg.
- Brain compiles the router at boot — RESTART the brain after any
  router code change before measuring (nearly measured stale code once).
- Stand: loco-321 OOMs near 5-6GiB (GC answered tenants; the pipeline's
  ensure_stand recipe handles recovery); .env SURREALDB_URL points at
  :8000 — always pass ws://localhost:18321 explicitly.
- Costs: re-QA legs $0.7-2; full ability sweep ~$2; keep the
  self-healing pipeline pattern for anything long.
