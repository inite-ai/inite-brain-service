# Next-session command — after the domain-pack + code-memory-gate build (2026-07-07)

> Self-contained brief. **Open this first.** Supersedes `next-session-2026-07.md`
> (that one is now historical — most of its open tracks shipped). Picks up after
> a long session that productionized the code-memory decision gate, consumed the
> last forward-compat pack fields, and built the Domain Pack registry + a public
> UI + a 6-pack industry library.

## Pre-flight

1. `git -C ~/Documents/inite-brain-service checkout main && git pull --ff-only`
   then `git log --oneline -20`. Main was at `#115` when this was written.
2. Read auto-memory **`code_memory_domain.md`** (full domain + gate + industry
   history, with gotchas + real numbers) and **`maxparams_program.md`**.
3. Acceptance bar for every PR: `pnpm exec tsc --noEmit` · `pnpm typecheck` ·
   `pnpm lint` (max-params=3, complexity=25, max-classes-per-file=1) · `pnpm test`
   · `pnpm test:e2e` · `pnpm test:e2e:jobs`. Baseline: **861 unit / 164 e2e /
   9 jobs**.
4. Workflow (verbatim): branch off main → small commits → PR (conventional
   title) → wait for `build-test` green (only required check; `summarize` 403 is
   ignored) → `gh pr merge <n> --squash --admin --delete-branch` (merge = prod
   deploy) → `git pull --ff-only`. Ask before the first admin-merge unless the
   user has said "делай/делай все" for the work in hand.
5. CI flakes seen this session (rerun `gh run rerun <id> --failed`, don't debug):
   testcontainers Docker 500 on globalSetup; a timing-sensitive jobs.real lease
   test. Also a transient network/DNS blip on `gh` — just retry.

## Shipped this session — DO NOT redo

- **Track B — extractionProfile consumed + real_estate pack** (`#93`).
- **Track D refactor** (`#94`) — dropped 2 complexity-gate suppressions. The 2
  `it.skip` in `concurrency.real-e2e` stay (infra-blocked: namespace/db migration
  split + rocksdb fairness).
- **Track A — global pack registry** (`#96`/`#97`): `registry_pack` in the
  `system` DB (migration 0042, `withAdminDb`), version immutability + yank +
  end-to-end trust, `registry:publish` scope, publish/discover/install-from-registry,
  CLIs (`pack:publish` / `pack:search` / `pack:install --registry` / `registry:seed`).
- **Track C — the trained Layer-1 decision gate, PRODUCTIONIZED** (`#101`,`#103`,
  `#105`,`#107`,`#110`,`#111`):
  - Silver harness by distilling the Layer-2 LLM teacher (`pnpm label:decisions`
    + `pnpm label:commitpackft` — the latter pulls diverse negatives from the HF
    datasets-server). `--verify` adds an LLM-judge for teacher precision
    (positive rate 94%→31% on CommitPackFT). `maxConfidence` + `--min-confidence`
    re-threshold offline.
  - Linear logistic-regression student (`gate-*.ts`), multi-label `kinds` heads,
    a frozen human golden (`gate-golden.ts`).
  - KEY finding: the model ALONE loses to the heuristic on the golden (human
    truth), so the default gate is **`HybridDecisionClassifier` = heuristic OR
    model** (golden F1 66.7 vs 62.1). A shipped default model
    (`models/decision-gate.model.json`, ~97 KB) makes `capture:decisions` use the
    hybrid by default; `test/gate-default-model.unit-spec.ts` is the CI regression
    guard. NOT ONNX — deliberate (heavy deps for a client-side gate).
- **evalFixtures consumed** (`#108`): `POST /v1/admin/packs/:id/eval` runs a
  pack's fixtures through the live extractor. No forward-compat field remains.
- **Industry pack library** (`#112`,`#114`): 6 first-party DISTRIBUTABLE packs —
  `real_estate`, `fintech`, `medical`, `legal`, `insurance`, `hr` — each with
  predicates + extractionProfile + evalFixtures + committed `packs/*.json`.
  `FIRST_PARTY_PACKS`; `test/industry-packs.unit-spec.ts` iterates it.
- **Registry UI** (`#115`): public `GET /registry/ui` — server-rendered HTML
  catalogue (no auth, HTML-escaped).

## Open tracks

### D. LoCoMo — the one remaining MAJOR track (paid)
Full paid LoCoMo run + published numbers (~$110, 2–4h) — the last item from
`docs/roadmap/mcp-and-memory.md`. Needs the user's explicit go for the spend.
See `docs/locomo.md`.

### Optional
- **ONNX/DistilBERT gate student** — deliberately NOT built. It needs heavy deps
  (`onnxruntime-node` ~100MB + a WordPiece tokenizer) in the dep-free client-side
  gate, plus a Python training pipeline, and can't be validated in-repo; the
  hybrid already beats the heuristic. The `DecisionClassifier` seam is ready if
  the user green-lights the deps + a data/ML setup.
- **More industry packs** — the pattern is proven; add one by copying an existing
  `*.pack.ts`, adding it to `FIRST_PARTY_PACKS`, generating `packs/<id>.pack.json`
  (the unit spec then covers it), done.
- **Gate tuning on a real repo** — run `label:decisions --verify` over a target
  repo's history, `train:decision-gate --min-confidence 0.9`, ship a per-repo model.
- **Registry follow-ons** — cross-instance mirroring, download counts, a richer UI.

## Files to read first
- Pack system + registry: `src/ai/domain-packs/*`, `src/registry/*`, `src/admin/
  domain-pack-install.service.ts`, `src/admin/pack-eval.service.ts`, `docs/domain-packs.md`.
- Code-memory gate: `src/code-memory/capture/*` (gate-*.ts, hybrid-classifier.ts,
  silver-dataset.ts, llm-verifier.ts, gate-golden.ts), `scripts/{label,train,capture}-*.ts`,
  `models/decision-gate.model.json`, `docs/code-memory/distillation-dataset.md`.

## Recommendation
The domain-pack + code-memory-gate work is feature-complete and productionized.
The only substantive remaining track is **D (LoCoMo)** — a paid one-off; confirm
the spend before starting. Everything else is optional polish (ONNX behind the
deps, more industries on demand). If not doing LoCoMo, this milestone is done.
