# Memory evaluation protocol

How we measure long-term conversational memory (LoCoMo + LongMemEval), and
why our numbers are deliberately harder to inflate than most published
results. Written to be shared with evaluation partners.

## Why a strict protocol

Published LoCoMo numbers are barely comparable across papers. Documented
failure modes in the field: shifted category labels in mem0-lineage
harnesses (per-category tables silently permuted), lenient LLM judges that
accept up to 63% of intentionally wrong but on-topic answers, generator
inflation (the same full-context baseline moves 72.6% → 92.6% from an
answer-model + CoT prompt swap alone), and cat-5 accounting errors (one
public incident inflated a headline by ~25pp). The dataset itself has a
~6.4% wrong answer key (audited), putting hard per-category ceilings well
below 100%. A memory system's claim is only meaningful relative to a
protocol that pins all of these.

## LoCoMo axis — representation quality

LoCoMo conversations are 16–26k tokens: they fit a modern context window,
so this benchmark cannot test capacity. What it does test — strictly —
is whether a derived memory representation answers better than reading
the entire transcript. Our rules:

1. **Verified category mapping.** True mapping (1 multi-hop, 2 temporal,
   3 open-domain, 4 single-hop, 5 adversarial) checked against dataset
   counts, not inherited from other harnesses. We found and fixed a label
   shift in our own scripts before trusting any per-category number.
2. **Strict binary judge, fixed model.** gpt-4.1-mini with a strict
   prompt on every leg. No judge upgrades between legs; the judge is a
   controlled variable, never a lever.
3. **Honest generator axis.** Headline numbers use gpt-4o-mini as the
   answer model. Stronger-generator results, when reported, are labeled
   as a separate comparability axis — never mixed.
4. **Own full-context baseline.** FC is computed on our harness with the
   same judge and the same questions, with image captions rendered into
   the transcript (and, symmetrically, into memory ingestion). All
   claims are deltas against our own FC, not against numbers from other
   papers.
5. **Official denominator.** Headline = categories 1–4 only. Adversarial
   (cat 5) is excluded from the headline and scored separately as
   abstention (the dataset's cat-5 answer key is unusable; every credible
   harness excludes it — the difference is whether they say so).
6. **Paired statistics on every A/B.** Per-question McNemar with
   discordant counts reported. Dev deltas under ~5pp are treated as noise
   unless paired-significant. Negative and null results are recorded with
   the same rigor as wins (our log includes five measured nulls and two
   measured regressions that we reverted).
7. **Dev / held-out split.** Conversations 1–5 iterate; 6–10 are touched
   only to confirm milestones. Our largest gain measured LARGER on
   held-out than on dev (+6.6pp vs +3.8pp) — the protocol's overfitting
   guard demonstrably works.
8. **One variable per leg.** Every experiment is a single env-flag change
   on an immutable raw substrate with versioned derivations — two
   derived "worlds" over the same raw data are A/B-able by flipping one
   read pin, with no re-ingestion.
9. **Run hygiene.** Every run reports dead-answer counts (empty/errored
   predictions); runs corrupted by infrastructure incidents are discarded
   and re-run, never reported.
10. **Token accounting.** Reports carry per-question generator
    prompt/completion tokens (avg/p90/max) — accuracy-per-token is a
    first-class result, not an afterthought.

**Current results under this protocol** (answer model gpt-4o-mini, strict
judge): dev-5 75.5% vs own FC 69.3%; held-out 76.3% vs own FC 69.0%
(McNemar p=8e-05, discordants 131:74) at roughly 16% of the FC prompt
tokens per question. Category profile on held-out: single-hop 84.9,
temporal 73.9 (FC: 30.9), open-domain 58.0 (FC: 40.0), multi-hop 60.0
(FC: 59.3).

## LongMemEval axis — capacity (added 2026-07-28)

LongMemEval-S: 500 questions, each with its own ~115k-token haystack of
chat sessions — deliberately larger than comfortable context, with
knowledge-update, temporal-reasoning, multi-session and abstention
subsets. This is the axis where context minimization is the product, and
where full-context baselines start losing to memory systems for
structural reasons.

Harness design:

- **Per-question tenant isolation** (each haystack is its own world;
  no cross-question contamination), via an admin-scoped per-call tenant
  override.
- **LLM-free ingestion**: raw turns are captured into the immutable
  episode substrate without extraction; the readable world is built by
  the session-window deriver (one LLM call per session) plus verbatim
  segment indexing (embeddings only). Ingest cost scales with sessions,
  not tokens-through-an-extractor.
- **Question-dated retrieval**: answers are generated as-of the
  question date (temporal correctness is read-time, not luck).
- **Reporting**: accuracy per question type (6 types), abstention rate
  on the `_abs` subset, per-question token accounting, error counts.
  Same strict judge as the LoCoMo axis.

## Sharing and comparability

For any joint evaluation we propose pinning, per leg: dataset file hash,
category mapping, judge model + prompt, answer model, denominator rules,
abstention convention, and paired-test methodology — before any numbers
are exchanged. We are happy to run partner systems through this harness
and/or re-run ours through theirs; under matched protocols, deltas are
meaningful — absolute numbers alone are not.
