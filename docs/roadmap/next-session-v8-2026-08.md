# Next session — V8: the insight layer + the BEAM gap (2026-08)

Context: V6/V7 closed the write tract (W3 merged behind a p=0.93
fresh-tenant confirm, PR #251), shipped the V7 profile points
default-off (PR #252), and measured four verdicts including two
honest nulls (validate-2026-08-results.md § "V6 legs"). The
competitive picture moved: BEAM-100K leaders (Exabase M-1 76.9,
Hindsight 73.4, Honcho 63.0) sit 2× above our 36.9-38.8 while we hold
record-class on LoCoMo (78.7 held-out) — the assistant-genre engine is
at the LIGHT/RAG floor and the gap is structural, not tuning. The
leaders' shared ingredients: an INSIGHT layer fed to retrieval
(Hindsight "observations"), importance/salience signals in scoring
(Exabase), order-preserving memory structure (SegTreeMem,
arXiv 2606.04555).

Ordered by value. Each block is self-contained; cut from the bottom.

## 0. Gate: DERIVER_COMPLETION_PASS in the golden flag budget

PR #252 added the key to test/golden/engine-behavior-flags.golden.json
next to its class precedent DERIVER_ASSISTANT_CONTENT (per-tenant
write-profile configuration, not an eval fork). Golden additions are an
owner decision — ack or revert. Two minutes.

## 1. The qualified insight lane (main engineering block)

The NAIVE version is a measured null — do not repeat it: composing
aspect aggregates into wd-v2 and letting the existing lanes carry them
scored a tie on MS (n=133) and −2.0pp on BEAM (summarization DOWN
3↓/0↑). Diagnosis: aggregate rows compete inside the fact budget and
displace the atomic facts the generator needed; nothing arbitrates
"insight vs fact" and summarization asks never preferentially receive
them.

The qualified version mirrors the fused segment leg (the one fusion
doctrine, audit W4 #18):

- **Insight leg inside the pipeline**: aggregates
  (source.recorder='aggregate-composer-v1'), community summaries, and
  promotion summaries (summary_*) retrieved as their OWN pseudo-fact
  pool — dense+BM25 through the same convex fusion — but entering the
  prompt under a SEPARATE budget slot (an insightTopK tuning constant,
  NOT part of factBudget), so insights never displace atomic facts.
- **Question-class dispatch, measured not guessed**: summarization /
  progressive-narrative / enumeration shapes (the lane registry already
  detects them) get the insight slot; pointwise asks skip it. The V6
  lesson generalizes: every evidence class pays on its own question
  class and drowns others — dispatch is the mechanism, not always-on.
- Profile point RETRIEVAL_INSIGHT_EVIDENCE (off | routed), default
  off; catalog + schema + gates.
- Legs: BEAM full-400 A/B vs v6ctl (summarization n=40 is the target
  row; the substrate ALREADY carries aggregates — see crib) and the MS
  block vs msfull-control. Verdict rule: non-negative overall AND
  summarization strictly up, else it stays a null like the naive cut.

## 2. Timeline evidence for event_ordering (BEAM 2.5-5% — an absent ability)

event_ordering is our worst BEAM row and nobody has touched it; the
substrate already has everything a timeline needs (validFrom-dated
facts, dated episodes, occurredAt segments). SegTreeMem's ablation
says the win comes from PRESERVING temporal order in what the model
sees.

- **Timeline assembler**: for ordering/sequence-shaped questions (the
  enumeration lane's order-lexicon already matches "in what order /
  before or after"), assemble a chronological evidence section —
  validFrom-sorted dated facts (+ elapsed annotations, which
  formatElapsed already renders) — instead of relevance-ordered
  shuffle. The W5 ordering-frame citation mode exists; this feeds it
  ordered input.
- Cheap first cut: a synthesize-side re-sort + section header for the
  routed question class. No new retrieval.
- Leg: BEAM full-400 vs v6agg-era control, read the event_ordering and
  temporal_reasoning rows.

## 3. Open V7 confirm legs (carried, cheap)

- **DERIVER_COMPLETION_PASS fresh-version confirm** (paid, ~1.5h
  wall): fresh tenant (locow8?), same verified diary write env as w3d
  PLUS the flag, full dev-5 ingest+derive+QA, pair vs
  var/locomo-w3d-dev5.json (same write code, only the pass differs —
  the cleanest ewave pair we have ever had). This is ALSO the
  extraction-recall record vector: if completion-pass recall moves
  dev-5, the held-out record attempt (E16 78.7) is next.
- **routed SSA arm** (read-side, ~15 min): env-ssa-routed exists in
  the job tmp; brain must run post-#252 code (dist rebuilt from main
  works now). Pair vs lme-ssa-v4control; expect ≈ fusedcap's +7.1
  with the 1200-char budget shaving tokens. TR/SSU under routed ≈
  their controls by construction — skip unless SSA surprises.

## 4. Importance/salience scoring (design-first, V8.5 build)

Exabase credits "temporal salience, importance scoring, cross-memory
coherence" as retrieval signals. We have recency/trust/corroboration;
importance is absent. Design note first (what signal, written where,
measured how) — the write side could stamp it at derive time (the
deriver already judges "durable"; a 0-3 salience per proposition is
one schema field), the read side folds it into scoreRows. No build
before the design note names the confirm leg.

## 5. Small engineering (fits between legs)

- **operator_action `ts` coercion on 3.x** (live WARN found by the W3
  leg boot): the audit write binds an ISO STRING into a `datetime`
  field — bind a Date (or type::datetime()) like every other write.
  One-liner + unit.
- **Dependabot sweep** (carried from the V5 brief, still undone):
  17 high / 16 moderate on main — triage per the security-sweep idioms.
- **Eval-stand throttling doc**: THROTTLE_DISABLED=1 is required for
  accelerated ingest legs (per-route @Throttle decorators ignore the
  env limits); document in docs/operations.md eval-stand section so
  the next leg-driver copies it.

## Stand crib (V6-verified mechanics — saves hours)

- Stand: `docker start loco-321` (OOM-recidivist ×3 now; exit 137
  normal, rocksdb intact). **ONE heavy chain at a time** — two
  concurrent ingest/QA chains OOM'd it twice this session.
- ⚠️ MS + BEAM wd-v2 worlds now PERMANENTLY carry aggregate rows
  (source.recorder='aggregate-composer-v1', composed 2026-08-07).
  Controls that predate them: lme-msfull-control, beam-100k-v6ctl are
  PRE-aggregate; beam-100k-v6agg / lme-msfull-agg are the
  post-aggregate re-QA — pair new legs against the AGG reports.
- Datasets are reaped from /tmp aggressively: LME = HF
  `xiaowu0162/longmemeval` file `longmemeval_s` → /tmp/longmemeval_s.json
  (curl -C - to resume; ~278MB, verify with json.load); BEAM =
  scripts/fetch-beam-dataset.py --split 100K.
- pnpm in this repo: ALWAYS `--ignore-workspace` (the repo is NOT in
  /Users/mikefluff/Documents/pnpm-workspace.yaml; a bare install runs
  the workspace root and breaks the hoisted node_modules both here and
  in worktrees).
- Branch legs: git worktree + `pnpm install --ignore-workspace` +
  copy .env + copy var/datasets/ (the LoCoMo runner reads
  var/datasets/locomo10.json relative to CWD).
- LoCoMo ingest legs: THROTTLE_DISABLED=1 in the brain env (V6: the
  brain's own throttler 429'd the runner at ~120/min and burned two
  4.5h attempts), fresh tenant per attempt (mint keys freely), the
  leg script is run-locomo-leg-w3.sh in the V6 job tmp — regenerate
  from this crib if gone: health gate + auth smoke + ingest →
  derive(force, fail-loud) → segments → QA(--skip-ingest, resume) with
  a DEGRADED gate on runner drops.
- Chain scripts must gate on CHECKPOINT COMPLETENESS, not runner exit
  codes (the runner exits 0 with errored rows; V6's completion-gated
  chain-msfull.sh v2 is the pattern).
- Analysis: beam-mcnemar.py pairs by questionId and treats
  errored-but-unjudged rows as correct when isAbstention=false — read
  JUDGED-ONLY, and check `errors:` in the report line before trusting
  a pair.
- CI: test/sota.e2e-spec.ts is a known flaky Napi/ONNX crasher on
  runners — `gh run rerun <id> --failed` once before diagnosing;
  fact-trust-ranking.e2e fails on clean main locally (pre-existing).

## Definition of done

- §1 verdict recorded (insight lane: default candidate / null) with
  BEAM summarization row called out either way.
- §2 event_ordering row measured on full-400.
- §3 both V7 confirms recorded; completion-pass verdict feeds the
  held-out record decision.
- Every leg's report carries provenance and lands in
  validate-2026-08-results.md (or a v8 results doc).
- Memory + MEMORY.md updated; no eval forks — new behavior enters as
  profile points only (the gates enforce this).
