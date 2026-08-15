# Round-2 measurement ladder — results + course correction (2026-08-03)

Protocol: docs/roadmap/next-session-measure-2026-08.md. One flag per leg,
same 20 BEAM-100K worlds (re-QA with --skip-ingest), paired McNemar vs B0,
contradiction gate 52-55%. Binary strict judge (gpt-4.1-mini) throughout;
tau_norm/nugget official scoring where noted.

**COURSE CORRECTION (owner, mid-session): stop the ablation ladder,
build the engine.** B1 and B2 both came back null/negative — two legs of
prompt-shaping around symptoms while three independent diagnoses point
at the same engine gaps. Ladder legs B3-B6 cancelled; the session
pivoted to the engine wave below. One confirm leg (all new engine
defaults vs B0) replaced the ladder.

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

## B2 — TEMPORAL_EVENT_INTERVALS + --asof-policy none → **NULL**

Report var/beam-100k-b2-0803.json, n=400, errored=0.

- Overall +0.8pp (35.3 → 36.1, p=0.72); temporal 32.5 → 32.5 (3 flips
  each way, p=1.0). The interval table does not pay on BEAM.
- Contradiction 55.0 — gate holds.

## Engine wave (built this session, commits 7cf543b..5da6bb7)

Evidence base: our extraction-lossiness diagnosis (2026-07-18, −20pp
recall), the LME-500 per-type diagnoses (temporal no-anchor
trace-verified; SSA "facts do not specify…" with verbatim in L0), and
the LME-SOTA research (docs/roadmap/lme-sota-research-2026-08.md:
verbatim beats extraction on SSA field-wide; absolute-date rendering is
most of the TR win).

- **E1 — verbatim-recall engine default** (9b1064b):
  detectVerbatimShape in the router; assistant-content questions pull
  BM25 episode quotes AND provenance excerpts via a force path that
  bypasses the global lane flags. The genre law is encoded in question
  shape, not deployment flags. SYNTHESIZE_VERBATIM_EXCERPTS=0 kills.
- **E2 — dates as data** (9b1064b): SYNTHESIZE_DATE_CONTEXT default ON
  (LoCoMo-convention eval profiles must pin =0);
  SYNTHESIZE_ROUTER_LEXICON_V2 default ON.
- **E3b — object normalization** (1bfa08f, EXTRACTION_OBJECT_NORMALIZE,
  default off): the span-grounded extractor proposes a minimal clean
  value; server admits it only when every word appears in the grounded
  span, else falls back to the span. valueSpan kept on the fact.
  Confirm leg before any default flip (prompt changes have regressed
  before: agent-qa 47.4→42.1 rollback).
- **E3a — deriver assistant-content** (90976be,
  DERIVER_ASSISTANT_CONTENT, default off): 'assistance'-aspect
  propositions for recommendations/answers/instructions given — closes
  the SSA hole at the substrate. Confirm on a FRESH derivedVersion.
- **E4 — driver v1 complete** (d919f71 + 5da6bb7): surface 3 projection
  registry (0076, GET /v1/projections + rebuild verb,
  PROJECTIONS_API_ENABLED) and surface 4 episode webhook push (0077,
  watermark-poll over recordedAt, metadata-only, HMAC, at-least-once,
  EPISODE_SUBSCRIPTIONS_ENABLED). All 4 surfaces of
  raw-substrate-driver-2026-08.md now exist.

### Confirm leg `ewave-0803` (all new engine defaults) vs B0

Report var/beam-100k-ewave-0803.json, n=400, errored=0.

- **No net harm on BEAM**: judged-only 35.3 → 35.6 (p=1.0), overall
  35.7 → 37.0 (+1.3pp, p=0.57). BEAM is not the wave's target genre
  (SSA/temporal live on LME) — the confirm's job was "defaults don't
  break the flagship axis", and overall they don't.
- Positive drift (each n.s.): instruction_following 35.0 → 42.5,
  knowledge_update 37.5 → 45.0, multi_session 32.5 → 40.0,
  preference 72.5 → 80.0, abstention-match 40 → 50.
- **WATCH: contradiction 55.0 → 45.0** (6 flips against / 2 for,
  p=0.29 — inside noise, but the gate metric). Forensics: NONE of the
  six flipped questions match the verbatim shape (all "Have I…"), and
  none route through lexicon-v2 — the remaining suspect was the global
  DATE_CONTEXT header.

### Disambiguation `ewave-nodc-0803` (ewave defaults, DATE_CONTEXT=0)

**DATE_CONTEXT acquitted.** CR across the three same-day runs:
B0 55.0 → ewave 45.0 → ewave-nodc 50.0; isolating the flag recovered
only 2 net flips (4 vs 2, p=0.69), and nodc still sits 5pp under B0
(p=0.5). With n=40 the per-run SE is ~7.9pp — all three readings live
in one noise corridor. Verdict: no evidence of DATE_CONTEXT harm;
engine defaults stay. The gate metric needs bigger n (or the B5-style
nugget run) before any future leg is allowed to claim CR movement
under ±8pp.

Ops note: the nodc first launch caught migration 0076 with
FLEXIBLE-before-TYPE (3.x parser rejects the whole script; every
tenant request 500s). Fixed in 268bb81, verified 9/9 statements
against the live stand; the leg-script smoke now aborts on 5xx too.

### Next: LME confirm legs (the wave's target genre)

`lme-temporal-ewave` (indices 233-365, world rebuild + QA on the new
defaults, real asOf) launched — pairs against the temporal rows of
var/lme-500-final.json (24.4% baseline). SSA 444-499 confirm follows;
E3a/E3b extraction confirms need a FRESH derivedVersion by design.

**Result (2026-08-03, run to completion): temporal 30.7%** (n=133,
judged 127, errored 0, derivedVersion wd-v2, avg prompt 5.3k tokens) vs
the 24.4% LME-500 baseline — **+6.3pp on the wave's target type** with
the same real-asOf protocol. Abstention on the 6 unjudged rows 66.7%.
The engine-wave defaults (E1 verbatim shape + E2 dates/lexicon) confirm
as a live improvement on the genre they were built for, consistent with
the BEAM confirm story (temporal there was flat; the win is
genre-local, as the segment-lane law predicts).

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
