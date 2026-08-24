# Fovea optics — from static-naive focusing to a calibrated adaptive policy (2026-08)

Companion to [memory-research §8-9](memory-research-2026-08.md) (the fovea
cascade) and [sota-gap-build](sota-gap-build-2026-08.md) (which shipped the
cascade *mechanism*). The mechanism — the lenses — now exists end to end
(L0 profile → L1 facts → L2 raw windows → L3 full-session escalation, plus the
T2 answer cache). This doc is about the part that is still crude: **how the
system decides where to put high resolution — the focusing policy, the
"optics".** Today that policy is static and naive; this is the researched plan
to make it adaptive, and — just as important — the honest boundary of where
adaptive is *not* worth it.

## 1. The diagnosis: the optics are static-naive (audited, not asserted)

Every "where to focus" decision in the cascade is currently a fixed constant, a
regex, or a linear heuristic:

| Decision (the "optic") | Today | File |
|---|---|---|
| Which lens/lane fires | `matchesAny(REGEX_PATTERNS)` — hardcoded regexes on the query (TEMPORAL/ENUMERATION/PREFERENCE/SUMMARY) | `answer-router.ts:317,327…` |
| Whether to escalate to L3 | boolean AND of fixed conditions (coverage < floor, verifier verdict, post-refine, anchor present) | `l3-escalation.ts` |
| Focus depth / aperture | fixed per-tenant constants: `rawWindowSpan`, `l3MaxSessions`, `l3TokenCap`, `abstentionMinTopScore`, `abstentionMinEvidence` | `retrieval-profile.ts` |
| Where to focus (session pick) | fact-hit **density** heuristic + a static temporal-overlap rule | `l3-escalation.ts:rankL3Sessions` |
| Fusion of lenses | fixed lane precedence + static fusion weights | `answer-router.ts:routeLane` |

There is zero learned routing, zero per-query adaptive budget, zero calibrated
confidence→depth mapping, zero uncertainty-driven allocation. The user's
framing is exactly right: the lenses are built, the focusing is naive.

## 2. The convergent thesis (three independent research passes agree)

Three SOTA scans — adaptive allocation, focus-signal calibration, adaptive lens
selection — converged on one design, which is not what "make it adaptive"
naively suggests:

**One calibrated uncertainty signal should drive three decisions that are
static today; the dominant lever is subtraction (cut waste / suppress noise),
not addition; and none of it is safe until the signal itself is proven
trustworthy.**

Three load-bearing findings, each from a different pass:

- **Allocation (R1).** The most-replicated adaptive win is *per-query depth
  gating by an uncertainty/difficulty signal* — and the gain comes from
  **cutting compute on the easy majority**, not piling it on hard queries
  (which backfires: "When More Thinking Hurts", "Thinking Hard Not Smart").
  Foveation wins in vision because "center = important" is a near-perfect
  spatial prior; **memory has no such prior — the query-relevance score IS the
  fovea**, so adaptive allocation is only as good as that score. A noisy score
  makes an adaptive allocator *amplify noise*.
- **Calibration (R2).** The uncertainty signal must be calibrated
  **per-query-class**, because our own segment-lane law (a lane that is +LoCoMo
  is −28pp on assistant-chats) is exactly the statement that a single global
  threshold is miscalibrated across classes. The conformal *guarantee* is
  largely cosmetic here — it needs calibration/test exchangeability, which our
  two live hazards (genre shift, deriver/generator swaps) break. The value is
  the calibration, not the certificate.
- **Lens selection (R3).** Against a strong hybrid-always baseline (what we run
  at 77.8 strict), a *positive* router mostly **risks regressions** — every
  misroute is a lane holding the gold that never fired (Adaptive-RAG's own
  router is 54.5% accurate and did **not** beat always-multi-step on accuracy;
  it bought cost, not correctness). The real lever, corroborated by "Power of
  Noise" (near-miss context actively degrades) + SKR/Mallen (unneeded retrieval
  hurts) + our own law, is **precision of suppression** — *not firing the lanes
  that inject noise for this query-class*.

The unifying shape:

```
                 ┌─────────────────────────────────────────┐
                 │  ONE calibrated confidence signal:       │
                 │  per-class isotonic( verifier verdict,   │
                 │     coverage score, top1−topN gap )      │
                 └───────────────┬─────────────────────────┘
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                         ▼
  DEPTH (R1)              FOCUS THRESHOLD (R2)       LENS SUPPRESSION (R3)
  escalate L3 / widen    the floor is calibrated,    suppress lanes with
  only when low-conf;    per-class — not a raw       net-negative history
  #sessions ∝ deficit    static constant             for this query-class
```

All three decisions are trained/calibrated from **one dataset we already
have**: the ablation-run mining (§8: "67% of misses have gold in facts") —
per-(query-class, lane, tier) outcome labels. No new labeling.

## 3. The prerequisite that everything hinges on (do first, free)

Because adaptive allocation *amplifies* a bad signal, step zero is not building
any adaptive decision — it is **measuring whether the confidence signal is
even calibrated**. Free, on the dev stand, no paid eval:

- Fit and plot a reliability diagram + ECE for `coverage_score → P(answer
  supported)` and for the verifier verdict, globally and per query-class, over
  the harness questions with gold labels.
- If the signal is already well-ordered (low ECE), adaptive gating will help.
  If it is noisy/miscalibrated per-class, that is itself the finding — fix
  calibration (§4.2) before wiring any depth/suppression decision to it.

This is the honest gate. Ship no adaptive optic whose driving signal hasn't
passed it.

## 4. The plan — cheapest-viable first, ROI-ranked

Each item notes what is **free to prototype + validate** (offline, dev stand)
vs what needs **paid eval** to confirm the end-task delta (the parked no-spend
program — these are queued, not run).

### 4.1 Confidence-gated L3 depth (highest ROI) — replaces static L3
Escalate to L3 / widen the L2 window **only when calibrated confidence is low**,
and scale `#sessions`/`span` to the coverage deficit rather than a fixed
constant. Signals already computed: verifier verdict, evidence coverage,
retrieval top1−topN gap. This targets our most expensive constant (`l3MaxSessions`,
`l3TokenCap`), cuts L3 cost on the easy majority, and is the regime where
adaptive provably beats static. **Free** to prototype as a pure rule over
existing signals + measure fire-rate/flip-rate on dev; **paid eval** only to
confirm the QA delta. Seam: `l3-escalation.ts` trigger + `rankL3Sessions`.

### 4.2 Per-class isotonic calibration of the focus signal — replaces the static floor
Reuse the in-repo isotonic path. Fit one calibrator per query-class mapping the
raw signal → P(correct); the escalate/abstain threshold becomes "calibrated P
below target", per class. Directly encodes the genre-dependence law. **Free** to
build + validate (reliability diagram/ECE per class on ~100–200 labeled
questions/class from the harness); **paid eval** only for the downstream delta.
Recalibrate on every model swap (swaps void the calibration set); keep the
fire-rate control-chart as the drift alarm. Seam: `abstention.ts` /
`verdict.ts` coverage decision + the calibration module.

### 4.3 Lens-suppression governor — replaces regex `matchesAny` selection
Not a positive router. Keep firing-bias high (don't starve recall of the strong
baseline); learn **per-lane × per-query-class suppression** rules from the
ablation-mined outcome labels — hard-suppress the genre-toxic combinations
(the segment-lane-on-assistant-chats class). Degrades gracefully: a missed
suppression = today's behavior; the failure mode is "we kept a slightly noisy
lane", never "we dropped the lane holding the gold". Tier-0 mechanism = embed
the query, nearest-centroid to labeled classes (Semantic Router pattern,
~ms), then apply the class's suppression set. **Free** to prototype + validate
lane-firing precision offline; **paid eval** for the end-task delta. Seam:
`answer-router.ts:routeLane`/`detectLane`.

### 4.4 Contextual bandit over the allocation vector (adopt only if 4.1 leaves money)
External policy over the frozen model (no weight ownership needed): a cheap
contextual bandit on (query embedding, score distribution, class) → allocation
vector (span, #sessions, escalate), reward = verifier verdict. Higher ceiling
than the rule in 4.1, moderate build. **Prototype free** with the verifier as
reward; **paid eval** to confirm. Gate: must beat the 4.1 rule first.

### 4.5 Soft score-mass session selection — refinement, not a rewrite
Replace the hard fact-hit *count* with calibrated score *mass* for `rankL3Sessions`;
optionally a tiny reranker. Likely single-digit, since the current heuristic is
already decent. **Free** to prototype.

## 5. Where static is fine — do NOT over-engineer (the honest boundary)

- **Write-side resolution / compression** (how much detail we *store*). The
  retrieval-vs-utilization diagnosis (arXiv 2603.02473) finds retrieval/
  selection moves ~20pt while write/compression strategy moves only 3–8pt.
  Elaborate adaptive L2-span or learned compression is low-ROI here.
- **FOVI-style geometric allocation priors** — they win on a near-perfect
  spatial prior memory does not have. Don't port the mechanism; port only the
  "allocate by relevance-score mass, non-uniformly" idea, and only once the
  score is calibrated (§3).
- **The conformal guarantee** — cosmetic under our exchangeability violations.
  Use the calibration, skip the certificate (Mondrian conformal only if a
  defensible per-class error *bound* is ever contractually needed).
- **Positive learned routing** — risks subtracting recall from a strong
  baseline for a cost (not accuracy) gain. Suppression governor, not selector.
- **RL memory manager (MemAgent-style)** — weights-owner-only, whole-model
  replacement, needs RL infra. Out of scope unless we own the generation model
  and intend to retrain.

## 6. Honest status & evidence caveats

- The cascade *mechanism* is built and (functional shakedown pending) composes;
  its *value* is unmeasured — the accuracy program is parked (no-spend).
- The adaptive-allocation numbers in the literature are mostly on math/reasoning
  benchmarks (MATH/AIME/LiveCodeBench), **not** memory QA — transfer to
  LoCoMo-style tasks is plausible but unproven. A memory-domain foveation
  inverted-U is not published anywhere (it would be our citable result).
- Everything in §4 is prototypable and *offline-validatable for free*; the
  end-task confirmation for each is a queued item in the parked paid-eval
  program, not a claim.

**One-line takeaway:** the next fovea step is not more lenses — it is a single
per-class-calibrated confidence signal driving depth, threshold, and
lens-suppression, built on data we already have, validated free before any
paid eval, with subtraction (cut waste, suppress noise) as the dominant lever
and the signal's own trustworthiness as the gate.
