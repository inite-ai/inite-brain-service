# Round-2 measurement ladder — running results (2026-08-03)

Protocol: docs/roadmap/next-session-measure-2026-08.md. One flag per leg,
same 20 BEAM-100K worlds (re-QA with --skip-ingest), paired McNemar vs B0,
contradiction gate 52-55%. Binary strict judge (gpt-4.1-mini) throughout;
tau_norm/nugget official scoring where noted.

## B0 — pairing base (router-v2 surgery + asOf-fix, no leg flags)

Report var/beam-100k-b0-0803.json, n=400, errored=0, 5037 avg prompt tok.

- **judged-only 35.3%** (n=360) — new best BEAM-100K number.
- **contradiction_resolution 55.0%** — gate holds (52-55 corridor).
- vs previous best (lane-off 31.1%, 2026-07-30): overall +7.7pp
  (p=0.0009), judged +4.2pp (p=0.086). The significant overall gain is
  abstention-driven (abstain-rate 0.6 → 0.4 with accuracy up).
- Watch-item: temporal 47.5 → 32.5 vs nolane (-15pp, p=0.11, n.s.) —
  first candidate to diagnose if B2 doesn't recover it.
- Per-ability: CR 55.0 / EO 7.5 / IE 27.5 / IF 35.0 / KU 37.5 / MS 32.5 /
  PF 72.5 / SUM 17.5 / TR 32.5 / abstention-match 40.0.

## B1 — SYNTHESIZE_ORDERING_FIRST_MENTION=1 → **LOSER, excluded**

Report var/beam-100k-b1-0803.json, n=400, errored=0.

- Binary judge: overall NULL (35.7 → 35.7, 17 flips each way, p=1.0);
  event_ordering **7.5 → 0.0**.
- Official tau_norm (offline re-score of saved predictions,
  scripts/offline-ordering-score.ts): **0.378 → 0.174**, F1 0.142 → 0.065.
  Worse on both metrics.
- Contradiction 52.5 — gate holds.
- **Mechanism**: the bare-list frame degenerates generation into
  contentless category labels ("error handling", "API integration")
  instead of specific dated events; B0's prose answers carry specifics
  that align with rubric items, B1's labels align with nothing (F1
  collapse). The sort never gets a chance to matter.
- Next round candidate: keep first-mention SORT, drop the bare-list
  FRAME — specificity must survive.

## Session ops notes

- Leg driver: $CLAUDE_JOB_DIR/tmp/run-beam-leg.sh — forced brain restart
  on attempt 1 (a leftover healthy brain runs the WRONG flag set), stall
  watchdog (runner log silent >25 min → kill runner+brain → resume from
  checkpoint), auth smoke after health (401 → abort leg in seconds, not
  400 burned questions).
- BRAIN_API_KEYS gotchas: .env stores an unquoted JSON array — shell
  sourcing (bash AND zsh) eats the double quotes; AND the .env key set is
  not the pipeline set (hash of loco-dev-key differs). Keys must be taken
  raw from the captured live-brain env (ps eww), not from .env.
- Errored runner rows are not checkpointed — 401 blast-throughs cost
  nothing and resume clean.
- LME dataset REAL index blocks (verified by python count, brief was
  wrong on 3 of 6): SSU 0-69, **MS 70-131 + 162-232 (two blocks!)**,
  SSP 132-161, temporal 233-365 ✓, KU 366-443 ✓, SSA 444-499 ✓.
