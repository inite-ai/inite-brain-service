# Next session: MEASURE the typed-dispatch round-2 ladder

Everything is built and flag-gated; nothing new needs writing before
numbers exist. This session is legs, McNemar, and verdicts. Prior
briefs: next-session-beam-2026-08.md (diagnoses + LME-500 final),
raw-substrate-driver-2026-08.md (surfaces 3+4 remain, separate track).

## State on entry (2026-08-03)

- LME-500 FINAL: 50.2% judged (n=470), temporal 24.4 / MS 51.2 /
  KU 63.9 / SSA 55.4 / SSU 82.8 / SSP 43.3. Report
  var/lme-500-final.json, checkpoint var/lme500.ckpt.jsonl. LME worlds
  were GC'd — re-runs require re-ingest (see offsets below).
- BEAM-100K worlds INTACT in loco-321 (co_beam_100k_*); re-QA with
  --skip-ingest ≈ $1-2/leg. Dataset at /tmp/beam_100k.json — if /tmp
  was purged again: `python3 scripts/fetch-beam-dataset.py --split
  100K --out /tmp/beam_100k.json`. LME dataset: HF
  `xiaowu0162/longmemeval`, file `longmemeval_s` (no extension) →
  /tmp/longmemeval_s.json.
- **B0 leg was RUNNING at session end** (router-v2 surgery + asOf-fix
  verification, current code, flags as the pipeline env): checkpoint
  var/beam-b0-0803.ckpt.jsonl, report var/beam-100k-b0-0803.json.
  READ IT FIRST — it is the pairing base for the whole ladder. Gate:
  contradiction_resolution must hold ~52-55%; if it regressed, stop
  and diagnose before any other leg.
- An LME-SOTA research agent was in flight at session end; its
  findings (leaderboard per-type, MS/temporal/SSA mechanisms of 60%+
  systems) may be appended below or in memory — check before
  designing Phase 3.

## The ladder (one flag per leg, McNemar vs B0, contradiction gate)

Brain start recipe (compiles code AT BOOT — restart per leg):

    set -a && . ./.env && set +a && SURREALDB_URL=ws://localhost:18321 \
    PORT=3033 PROCESS_ROLE=api EPISODE_SUBSTRATE_ENABLED=1 \
    INGEST_EPISODE_ONLY=1 BRAIN_TENANT_OVERRIDE_ENABLED=1 \
    SEARCH_FACT_CENTRIC_ENABLED=1 MULTI_HOP_SYNTH_EVIDENCE_UNION=1 \
    RETRIEVAL_DERIVED_VERSION=wd-v2 SEARCH_SEGMENT_LANE_ENABLED=0 \
    SYNTHESIZE_ANSWER_ROUTER_ENABLED=1 BRAIN_API_KEYS='<pipeline keys>' \
    <LEG FLAG>=1 node -r ts-node/register -r tsconfig-paths/register src/main.ts

Leg runner (BEAM):

    npx ts-node -r tsconfig-paths/register scripts/run-beam.ts \
      --dataset /tmp/beam_100k.json --brain-url http://localhost:3033 \
      --api-key loco-dev-key --skip-ingest --judge \
      --conversation-concurrency 2 \
      --resume var/beam-<leg>.ckpt.jsonl --out var/beam-100k-<leg>.json

- **B1** `SYNTHESIZE_ORDERING_FIRST_MENTION=1` — event_ordering 0-2%
  is the biggest expected jump (official metric is tau_norm over the
  newline-split response; partial order already pays).
- **B2** `SYNTHESIZE_TEMPORAL_EVENT_INTERVALS=1` AND runner flag
  `--asof-policy none` — BEAM golds are event-to-event, no "today".
- **B3** `SYNTHESIZE_INSTRUCTION_LANE=1` — IF ~35-40 → 50+ target
  (instruction IS captured as a preference fact; application was the
  gap; unconditional injection is the structural fix vs LIGHT).
- **B4** `SYNTHESIZE_LANE_WIDE_PROBE=1` — summarization 18 / MS 35.
- **B5** winners combined + `--nugget-judge` → paper-comparable
  numbers (vs MemIR CR 32.3 official / vendor ~60 unverifiable; ours
  under strict binary is the harsher headline).
- **B6 (KU decomposition)** `SYNTHESIZE_LANES_DISABLED=t3` then `=t5`
  on the B0 config — closes the T3-vs-T5 blame question.

## LME temporal mini-axis (one rebuild, then cheap legs)

Temporal questions are dataset indices 233..365 (order: MS 0-132,
SSU 133-202, SSP 203-232, temporal 233-365, KU 366-443, SSA 444-499 —
VERIFY with a 5-line python count before spending). Rebuild once:

    npx ts-node -r tsconfig-paths/register scripts/run-longmemeval.ts \
      --dataset /tmp/longmemeval_s.json --brain-url http://localhost:3033 \
      --api-key loco-dev-key --sample-offset 233 --samples 133 \
      --question-concurrency 3 --judge --resume var/lme-temporal-<leg>.ckpt.jsonl \
      --out var/lme-temporal-<leg>.json

(no --skip-ingest on the first leg — worlds are gone; subsequent legs
re-QA the same worlds WITH --skip-ingest and fresh checkpoint files).
Legs, one variable each, paired vs the final-run temporal rows:
L1 `SYNTHESIZE_DATE_CONTEXT=1` (unrouted relative-date questions had
NO anchor at all); L2 +`SYNTHESIZE_ROUTER_LEXICON_V2=1`;
L3 +`SYNTHESIZE_TEMPORAL_EVENT_INTERVALS=1` (keep real asOf on LME —
distance-to-today questions need it; the interval table serves the
event-to-event kind); L4 combo. Winner → full-500 confirm (once,
~$15-20, end of program).

## LME SSA/MS legs (diagnosed 2026-08-03 from the final checkpoint)

- SSA 55.4%: failures are "facts do not specify…" while the verbatim
  assistant turn sits in L0. Leg: `SEARCH_EPISODIC_LANE_ENABLED=1` +
  `SYNTHESIZE_SOURCE_EXCERPTS=1` on SSA indices 444-499 (56 worlds,
  rebuild once). Genre note: this lane was NULL on LoCoMo — SSA is
  its native genre; expect the sign to flip.
- MS 51.2%: failures are partial enumeration (3→1 items, $185→empty).
  Leg: `SYNTHESIZE_LANE_WIDE_PROBE=1` on MS indices 0-132 (expensive
  rebuild, 133 worlds — run AFTER the BEAM B4 verdict; if B4 is null
  on BEAM MS, redesign before paying).

## Protocol + ops reminders

- One variable per leg; same worlds; paired McNemar; contradiction
  never regresses; brain RESTART per leg (compiles at boot).
- Wrap every long run in the WATCHDOG pattern: Surreal OOM mid-pass
  hangs the runner past the loop's self-heal (kill runner + brain on
  :3033; the loop's ensure_stand recovers). Memory:
  beam-round2-build-2026-07-31 has the exact recipe.
- The machine SLEEPING froze everything for 28h once — run long legs
  under `caffeinate -is <cmd>` or with the lid open.
- macOS purges /tmp: both datasets may need refetch (paths above).
- Prompt forensics: any QA call with `X-Brain-Debug: 1` + admin key →
  GET /v1/admin/traces (+/:requestId) per tenant. GC removes worlds —
  trace BEFORE the leg's cleanup.
- Costs: BEAM re-QA $1-2/leg; LME temporal rebuild ~$3-5 then
  ~$0.5/leg; full-500 confirm ~$15-20 once.
