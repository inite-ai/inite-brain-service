# Track C — the trained Layer-1 decision gate (dataset → train → serve)

The capture pipeline's Layer-1 is a cheap binary gate: *does this commit's text
(message + PR body, no diff) carry an engineering "why" — a decision / rationale
/ invariant / gotcha — worth an LLM extraction call?* It ships today as
`HeuristicDecisionClassifier`, a stand-in behind the `DecisionClassifier` seam.
A trained model would drop into that exact seam. This doc is the data plan +
the harness that produces the training corpus.

## Why we distill instead of using a public corpus

No public dataset labels the `decided / because / invariant / gotcha` taxonomy
on the commit-message + PR modality. The nearest public sets (verified where
noted) are useful for **external calibration / eval**, not as drop-in labels:

- **CoMRAT / OOM-Killer** — `arxiv.org/pdf/2506.10986`, dataset +
  classifiers at `zenodo.org/records/10063089`. Sentence-level `Decision /
  Rationale / Supporting Facts` on Linux-kernel commit messages; the authors
  train cheap **BiLSTM binary detectors** for Decision and Rationale — a direct
  precedent for our gate. Maps to `decided` / `because`; aggregate sentence →
  commit. *(primary-source; not re-verified in the last research run.)*
- **SATD "different sources"** — `github.com/yikun-li/satd-different-sources-data`
  (Springer `10.1007/s10664-023-10297-9`). **5,000 commit messages + 5,000 PR
  sections**, 103 Apache projects, labeled non-SATD vs 4 SATD types — exactly our
  modality; usable as an external binary/typed gold set. *(verified 3-0.)*
- **Maldonado SATD** — `github.com/maldonado/tse.satd.data`. Manually labeled
  SATD, but modality is **code comments** → needs re-mapping. *(verified 3-0.)*
- **Levin & Yehudai (1,151 commits, corrective/perfective/adaptive)**,
  **Ghadhab (1,793 balanced)** — commit *intent*, not "why"; use as negatives /
  features only. *(1151 & 1793 verified 3-0; the Zenodo license claim for Levin
  was refuted — check it before reuse.)*
- **CommitPack / CommitPackFT / CommitBench** (HF `bigcode/*`, `Maxscha/commitbench`)
  — large but **unlabeled** for our taxonomy; base corpus for silver-labeling.

Conclusion: **distill**. The existing Layer-2 LLM extractor is the *teacher*; a
commit is decision-bearing iff the teacher extracts ≥1 candidate. Its verdicts
are silver labels for a cheap student (BiLSTM / DistilBERT), validated against
CoMRAT + SATD as external gold. This is self-consistent: the gate's job is
precisely to admit what Layer-2 will extract.

## The harness

`pnpm label:decisions` (`scripts/label-decisions.ts` → `src/code-memory/capture/
silver-dataset.ts`) runs the teacher over a git range and writes one JSONL row
per non-merge commit:

```bash
OPENAI_API_KEY=... pnpm label:decisions -- \
  --range origin/main~2000..HEAD \
  --out data/code-memory/silver-decisions.jsonl \
  [--model gpt-4o-mini] [--limit 500] [--concurrency 6]
```

Each row: `{ sha, text, label, kinds, candidateCount, signals, heuristic,
authorDate }` — `text` is the exact classifier input (message + PR body);
`label` is the teacher's binary verdict; `kinds` seeds a future multi-label head.

**Key difference from the production capture pipeline:** the harness runs the
teacher over EVERY commit, *not* behind the heuristic gate. Gating first would
hide the heuristic's false negatives — the very examples a trained student must
learn. Every row also records the current `heuristic` verdict, and the summary
reports `heuristicFalseNeg` (missed "why") + `heuristicFalsePos` (wasted LLM
calls) — the payoff signal that justifies training a model at all.

Generated datasets live under `data/code-memory/` and are git-ignored.

## Recommended path + sizes

1. Label the project's own history + optionally a CommitPackFT slice with the
   harness → tens of thousands of silver rows, cheaply.
2. Train a binary student (DistilBERT or BiLSTM) on `text → label`. Rough sizes:
   **~2–5k examples/class** for a decent baseline, **10k+/class** for a strong
   one — well within reach of silver-labeling.
3. Calibrate/validate on CoMRAT + SATD-"different-sources" as external gold
   (hundreds–1k hand/strong-LLM-checked items suffice).
4. Wrap the student as a `DecisionClassifier` implementing
   `classify(commit): Layer1Verdict` (binary `likelyDecision` + `reason` =
   `model p=…` + `signals`). The capture pipeline is unchanged — swap the
   heuristic for the model at the same seam.

## The trained gate (train → serve), in-process, zero-dep

The shipped student is a **logistic regression** over hashed token n-grams of
the commit text PLUS the deterministic commit signals — deliberately linear, not
a BiLSTM/DistilBERT: the Layer-1 gate runs client-side (CI / git hook) with no ML
runtime, the input is short commit text, and a linear model trains in seconds and
serialises to a tiny JSON. A heavier student (DistilBERT via ONNX) can replace it
behind the same `DecisionClassifier` seam if metrics ever demand — the pipeline
never changes. Features live in one place (`gate-features.ts`) shared by trainer
and server, so train-time and serve-time features always match.

### Train

```bash
pnpm train:decision-gate -- \
  --data data/code-memory/silver-decisions.jsonl \
  --out  data/code-memory/decision-gate.model.json \
  [--epochs 25] [--lr 0.1] [--l2 0.0001] [--threshold 0.5] [--holdout 0.2] [--seed 42]
```

Deterministic (seeded), fully offline. It holds out a slice (bucketed by commit
sha) and prints **model-vs-heuristic** precision/recall/F1 against the teacher
label — the payoff check: does the trained gate beat the heuristic? The model
artifact is a portable sparse JSON (`{version, config, threshold, bias, weights}`),
git-ignored under `data/code-memory/`.

### Serve

Point the capture CLI at the model — the trained gate replaces the heuristic at
the same seam, so nothing else changes:

```bash
OPENAI_API_KEY=... BRAIN_API_KEY=... pnpm capture:decisions -- \
  --range origin/main..HEAD --brain-url https://brain.inite.ai \
  --gate-model data/code-memory/decision-gate.model.json
```

Without `--gate-model`, capture uses `HeuristicDecisionClassifier` as before.

### Files
- `gate-features.ts` — `featurize` (hashing trick + structured signal features),
  shared by train + serve.
- `gate-train.ts` — `trainGate` (SGD logistic regression, seeded, prunes
  near-zero weights).
- `gate-classifier.ts` — `GateModel`, `predictProba`, `evaluateGate`,
  `TrainedDecisionClassifier` (the `DecisionClassifier` impl).
- `scripts/train-decision-gate.ts` (`pnpm train:decision-gate`), and the
  `--gate-model` flag on `scripts/capture-decisions.ts`.

### Remaining
Run `label:decisions` over real history to produce a real corpus, train, and
compare F1 vs the heuristic on a hand-checked slice; tune `--threshold` for the
precision/recall trade-off the gate wants (higher threshold = fewer wasted LLM
calls, more missed "why"). Optionally add a multi-label (`kinds`) head or an
ONNX BiLSTM/DistilBERT student behind the same seam.
