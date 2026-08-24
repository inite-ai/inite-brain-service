# Measurable economics + Memory Reliability Index (2026-08)

The external audit (2026-08-24) named two strategic bets we had *ingredients*
for but had not *worked through*:

- **Bet #2 — adaptive optics with measurable economics.** The adaptive half is
  built (Optics-1 calibration; §4.1 L3-depth, §4.2 abstention, §4.3
  lens-suppression as dynamic budget). The **measurable** half is a scaffold:
  the ECE/Brier reliability cockpit exists (`admin.controller.ts:197`) but runs
  against a bootstrap gold set that is **empty on dev → 0/0**, and there is **no
  accuracy–latency–cost Pareto curve** and no "ship only on a proven curve
  improvement" gate.
- **Bet #3 — experience memory + a public Memory Reliability Index.** Strategy
  memory (G4) is a *partial* experience memory (strategies that worked/failed,
  k=1); it is **not** extended to tool trajectories / verified outcomes. The
  **MRI does not exist** — its seven dimensions map to *scattered* components
  (poisoning = MINJA #312; isolation = user-scope + G6 + the stats fix;
  abstention = §4.2; premise-awareness = MemTrap shakedown + the verifier arm;
  citation = the require-citations guard; freshness = the answer-cache, whose
  invalidation is *incomplete*) but nothing is packaged as a measured index.

The common blocker of both is **one parked thing**: the paid accuracy eval +
materialized gold labels (no-spend). This doc separates, per bet, **what is free
to build now** (the measurement *structure* — collectors, index, curve harness,
the experience schema) from **what only fills with real numbers once the eval is
unfrozen**. We build the free scaffolds; the accuracy-dependent cells read
`N/A — pending eval` honestly rather than a fabricated number.

---

## Part 1 — Economics / the accuracy–latency–cost Pareto policy (bet #2)

Goal: make "ship a change only when it *provably* moves the accuracy–cost–latency
frontier the right way" a *mechanism*, not a slogan.

### 1.1 The three axes and their sources

| Axis | Metric | Source (free) | Source (real numbers) |
|---|---|---|---|
| **Accuracy** | end-task correctness | verifier `supported`-rate as a **cheap online proxy** (already emitted); reliability ECE against gold | paid eval (LoCoMo/LME/BEAM) — parked |
| **Latency** | p50/p95 synth wall-clock | existing spans/telemetry (`synthesize.*` timings) | same (already real) |
| **Cost** | tokens × price | existing `COST_*_USD_PER_MTOK` + per-call token counts | same (already real) |

Latency and cost are **already real** (telemetry). Only the accuracy axis has a
free *proxy* (verifier supported-rate + ECE) and a *true* value that waits on
eval. So the curve is drawable **today** with the proxy on the y-axis, and
becomes authoritative when the eval axis is unfrozen.

### 1.2 The artifact

A `PolicyOperatingPoint` record per (config, flag-vector): `{accuracyProxy,
eceOrNull, latencyP50, latencyP95, costPerQuery, flags[]}`, collected over a
run. A small reporter renders the **Pareto frontier** over the operating points
and flags dominated points. This is where each optic's flag combination gets
plotted, so "does §4.1/§4.2/§4.3 earn its cost?" becomes a point on a chart, not
a claim.

### 1.3 The ship-gate (the actual policy)

A change is **promotable** only if its operating point is **not dominated** on
(accuracyProxy↑, cost↓, latency↓) versus the current default AND — once eval is
unfrozen — its true-accuracy delta is non-negative within noise. Until eval is
unfrozen the gate runs on the **proxy + cost + latency** only and is advisory
(it *reports* domination, does not block). This matches the "no-spend, measure
free first" discipline.

**Free now:** the operating-point collector, the Pareto reporter, the proxy
accuracy signal, latency/cost wiring. **Waits on eval:** the true-accuracy axis
and the hard promote gate.

---

## Part 2 — The Memory Reliability Index (bet #3)

Seven dimensions. Each row states its **collector** and whether it is **free**
(computable from existing tests/telemetry/mechanisms today) or **eval-gated**
(needs the parked accuracy program). The MRI is an *aggregator over signals we
already emit* — not new science.

| # | Dimension | Definition | Collector | Status |
|---|---|---|---|---|
| 1 | **Correctness** | end-task answer correctness | paid eval | **eval-gated** → `N/A pending eval` |
| 1b | **Premise awareness** | resists belief-distortion (cited-counterfactual) | MemTrap shakedown pass-rate + `FOVEA_PLAUSIBILITY_CHECK` downgrades | **free** (structural) |
| 2 | **Freshness / stale-answer rate** | fraction of served answers invalidated by a newer fact | answer-cache invalidation telemetry — **requires F1 fix first** (additive-write invalidation) | **free after F1** |
| 3 | **Citation coverage** | % of served `supported` answers carrying ≥1 citation | verdict telemetry + the require-citations guard counter | **free** |
| 4 | **Poisoning resistance** | MINJA-class injection GAP count | MINJA red-team suite (#312) result (0 GAP) | **free** |
| 5 | **Tenant/user isolation** | cross-user/tenant leak count | user-scope + G6 + stats-fix e2e pass-rate | **free** |
| 6 | **Abstention calibration** | ECE of the abstain decision vs correctness | §4.2 focus-signal reliability | **eval-gated** (needs labels) |
| 7 | **Cost & latency** | tokens/$/p95 per query | telemetry (= Part 1 axes) | **free** |

**Free now (5 of 7 fully or structurally):** premise-awareness, citation
coverage, poisoning resistance, isolation, cost/latency. **Gated:** correctness
+ abstention-calibration (need eval); freshness (needs F1 fix, then free).

### 2.1 The artifact

An `MriReport` = `{ generatedAt, dimensions: {name → {value | 'pending-eval',
source, asOf}} }`, produced by an aggregator that reads each collector. Surface:
an admin endpoint `/v1/admin/mri` (brain:admin) and a `pnpm mri:report` that
writes a signed markdown snapshot. The public version is the same report with
tenant identifiers stripped — that becomes the "Memory Reliability Index" we can
publish, honest about which cells are still `pending-eval`.

---

## Part 3 — Experience memory: strategy → tool trajectories (bet #3)

G4 strategy memory today stores a distilled *advice string* per (worked/failed)
strategy. The bet is to store **tool trajectories + verified outcomes** — the
agent's *experience*, not just conversational facts.

**Extension (default-off, additive):**
- New optional fields on the strategy item: `trajectory?: ToolStep[]`
  (`{tool, argsDigest, resultDigest, ok}`), `verifiedOutcome?: 'success' |
  'failure' | 'unknown'`, `outcomeEvidenceRef?`.
- Capture: when a consumer reports a completed tool run + outcome (a new
  ingest surface), distill it into a trajectory-bearing strategy item (reuse the
  existing Mem0 ADD/UPDATE/NOOP dedup).
- Retrieval: unchanged lane (k=1, advisory, **verifier-parity exception stays** —
  a trajectory is advice, not evidence), but a retrieved item can now carry its
  trajectory into the generator's fenced advisory section.
- Migration adds the optional columns; flag `STRATEGY_TRAJECTORIES_ENABLED`
  default-off. LongMemEval-V2 (arXiv 2605.12493) is the benchmark this targets;
  we have a smoke (`var/lme-v2smoke.json`) but no measured run — that stays
  parked with the rest of the eval.

**Cognitive-trap caveat (from the MemTrap work):** a trajectory-bearing strategy
memory is *more* exposed to Cognitive-Bias / Trauma fixation than the advice
string (it carries a concrete past path). Enabling it must ride the §4.3
lens-suppression + the verifier arm, and its own trap-shakedown scenario.

---

## Build plan (what ships free, in order)

1. **MRI aggregator + report** (`/v1/admin/mri` + `mri:report`) — packages the 5
   free dimensions now; `pending-eval` for correctness/abstention; wired to F1
   for freshness once fixed. *Free.*
2. **Economics operating-point collector + Pareto reporter** — proxy accuracy +
   latency + cost per flag-vector; advisory domination report. *Free.*
3. **F1 answer-cache freshness fix** — unblocks the freshness dimension (and is a
   before-enable hardening item regardless).
4. **Strategy trajectories** (`STRATEGY_TRAJECTORIES_ENABLED`, default-off) —
   the experience-memory extension. *Free to build; measured only under LME-V2,
   parked.*

**Waits on the owner un-parking eval:** the true-accuracy axis, the hard
promote-gate, the correctness + abstention-calibration MRI cells, the LME-V2
number. Everything else is buildable now and is honest scaffolding: real where
we have telemetry/tests, `pending-eval` where we don't.
