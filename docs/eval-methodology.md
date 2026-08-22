# Strict evaluation methodology

Why our memory-benchmark numbers look lower than most published ones,
why that is deliberate, and how to convert between the two currencies.

Long-term-memory benchmark scores are not a scalar — they are a
**currency**. The same engine, answering the same questions, moves by
double digits depending on the judge prompt, the answer model, the
category accounting, and whether abstention is scored honestly. We
measured those conversion factors instead of riding them. This page is
the public statement of the protocol; the full per-axis detail
(LoCoMo / LongMemEval / BEAM harness design) lives in
[eval-protocol.md](eval-protocol.md), and the LoCoMo runner docs in
[locomo.md](locomo.md).

## 1. The strict-judge protocol

1. **Fixed strict judge, never a lever.** Every leg is graded by the
   same pinned judge model (gpt-4.1-mini) with a fixed, verbatim,
   version-bumped prompt ([locomo.md](locomo.md#llm-judge-scoring---judge)).
   The prompt contains no "be generous" / "give benefit of the doubt"
   instructions: a prediction is CORRECT only if it conveys the gold
   answer's essential information, and numeric values and dates must
   match in meaning. Judge upgrades between legs are forbidden — the
   judge is a controlled variable.
2. **Held-out gold.** LoCoMo conversations 1–5 are the iteration set;
   6–10 are touched only to confirm milestones. The guard demonstrably
   works: our largest gain measured *larger* on held-out than on dev
   (+6.6pp vs +3.8pp) — the opposite of what overfitting produces.
3. **Abstention counted honestly.** LoCoMo category 5 (adversarial:
   the gold answer is a refusal) is excluded from the headline — its
   answer key is unusable, and every credible harness excludes it; the
   difference is whether they say so. We score it separately as an
   abstention rate. LongMemEval's `_abs` subset and BEAM abstention use
   one shared decline-detection implementation. A confabulated specific
   answer is never credited.
4. **Own full-context baseline.** The FC baseline is computed on our
   harness, same judge, same questions, same rendering of image
   captions. All claims are deltas against our own FC — never against
   numbers lifted from other papers.
5. **Paired statistics on every A/B.** Per-question McNemar with
   discordant counts reported. Measured noise floors are enforced:
   dev-5 headline deltas under ~2.2pp (n=762) are noise; re-deriving
   the same world with the same code moves the headline ±0.8pp and
   single categories up to ±3.5pp, so derive-side effects must clear
   ~4pp per category to be readable. Nulls and regressions are recorded
   with the same rigor as wins.
6. **Judge-calibration probe (standing gate).** Any new eval axis must
   score a set of intentionally-wrong, topically-adjacent answers and
   report the judge's acceptance rate next to the headline. An axis
   without this number is not evidence; a 90+ on it is not a result.
7. **Run hygiene and token accounting.** Dead-answer counts reported
   per run; infrastructure-corrupted runs discarded and re-run, never
   reported; per-question generator prompt/completion tokens
   (avg/p90/max) carried in every report — accuracy-per-token is a
   first-class result.

## 2. Measured judge inflation

Numbers we recorded on our own harness while calibrating the protocol:

- **A lenient judge accepts ~62.8% of deliberately wrong answers.**
  Probing the standard gpt-4o-mini LoCoMo judge configuration with
  intentionally wrong but topically adjacent answers, it graded 62.8%
  of them CORRECT. Vague topical adjacency passes; only crisp factual
  contradiction reliably fails.
- **~6.4% of the LoCoMo gold key is broken** (hallucinated facts,
  wrong temporal reasoning, wrong speaker attribution), which puts the
  **theoretical ceiling for a perfect system at ≈93.6%** under exact
  judging. Per-category ceilings sit correspondingly below 100.
- **Generator inflation:** the same full-context baseline moves
  **72.6% → 92.6%** from an answer-model + CoT prompt swap alone — no
  memory system involved. Headline numbers that don't pin the answer
  model are measuring the generator.
- **Accounting drift:** mem0-lineage harnesses have shipped shifted
  category labels (per-category tables silently permuted), and one
  public incident inflated a headline by ~25pp through category-5
  accounting alone.

These findings are now **independently confirmed by Penfield Labs'
public audit** ([We audited LoCoMo: 6.4% of the answer key is wrong,
and the judge accepts up to 63% of intentionally wrong answers](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg)):
auditing all 1,540 scored questions they find 99 broken gold answers
(6.4%), a 62.81% judge acceptance rate for intentionally wrong
topically-adjacent probes under the standard gpt-4o-mini judge, and
the same ≈93.6% ceiling.

## 3. Lenient headlines are a different currency

Vendor-published LoCoMo numbers in the low 90s exist and are
reproducible under their own protocols — mem0's benchmark overview
([AI Memory Benchmarks in 2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026))
and the research page it links report per-category LoCoMo scores
around 92 (temporal) and 91 (multi-hop) for their stack, with
open-domain at 72.7. The widely reused mem0-lineage evaluation
harness those numbers ride instructs its LLM judge to grade
generously; under a judge configuration with that property we measured
the 62.8% wrong-answer acceptance above. Those scores and ours are
therefore **different currencies, not different engines** — both
internally consistent, not mutually comparable.

Conversion factors we measured between the currencies:

| Conversion | Factor | How measured |
|---|---|---|
| Strict binary → official BEAM nugget (rubric partial credit) | ≈ 1.3× | our own paired reading of the same run (0.353 binary vs 0.46 nugget) |
| Strict nugget → lenient vendor-harness (BEAM) | ≈ 1.5–2.0× | currency triangulation against the AMB vendor leaderboard |
| Single-lane extreme (BEAM contradiction resolution) | ≥ 12× | 0.006–0.05 strict for *all* published systems vs 60+ on a vendor harness |
| LoCoMo / LongMemEval unpinned vendor claims | +20–40pp | cross-protocol comparison of published vs pinned re-runs |

Applying the ceiling and acceptance-rate corrections, our strict
LoCoMo 77.8 is plausibly equivalent to a mid-80s score in the lenient
currency — stated as an estimate, because the honest direction of
travel is pinning protocols, not converting headlines.

## 4. Our numbers, in strict currency

All rows: answer model gpt-4o-mini, strict gpt-4.1-mini judge,
category-5 excluded from LoCoMo headlines, per-question paired stats.
CIs are 95% binomial intervals on the judged denominator; for any
*delta* the load-bearing statistic is the paired McNemar, not CI
overlap.

| Axis | Result | n | 95% CI |
|---|---|---|---|
| LoCoMo headline (cats 1–4, dev-5 control) | **77.8%** | 762 | 74.8–80.7 |
| LoCoMo held-out vs own full-context | **76.3% vs 69.0%** | — | McNemar p=8e-05, discordants 131:74 |
| LongMemEval-S (full 500) | **48.0%** | 500 | 43.6–52.4 |
| BEAM-100K, strict binary | **35.3%** | 360 judged | 30.4–40.3 |
| BEAM-100K, official nugget scoring | **0.46** | — | vs the 0.358 published LIGHT anchor |
| BEAM contradiction resolution, strict binary | **52–55%** | two paired legs | vs ≤5% for all configs in the original paper |

Context for the LoCoMo rows: the memory system beats our own
full-context baseline at roughly **16% of the FC prompt tokens per
question**, and the held-out category profile is single-hop 84.9,
temporal 73.9 (FC: 30.9), open-domain 58.0 (FC: 40.0), multi-hop 60.0
(FC: 59.3). Against the ≈93.6% gold ceiling, 77.8 strict is
frontier-competitive; chasing >85 by protocol imitation would be
measurement inflation, not engine improvement.

## 5. Comparing against these numbers

For any joint evaluation we pin, per leg, **before** numbers are
exchanged: dataset file hash, category/ability mapping, judge model +
prompt + a judge-calibration probe (acceptance rate on intentionally
wrong answers), answer model, denominator rules (category-5 in/out),
abstention convention, retrieval token budget, and the paired-test
methodology. We are happy to run partner systems through this harness
and/or re-run ours through theirs; under matched protocols, deltas are
meaningful — absolute numbers alone are not.

## See also

- [eval-protocol.md](eval-protocol.md) — the full three-axis protocol
  (LoCoMo / LongMemEval / BEAM harness design and per-axis rules).
- [locomo.md](locomo.md) — running the LoCoMo axis, judge prompt
  verbatim, cost.
- [eval.md](eval.md) — the in-house production retrieval gate that
  runs in CI.
