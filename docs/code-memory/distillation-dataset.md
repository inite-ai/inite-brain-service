# Track C — training the Layer-1 decision gate (distillation dataset)

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
