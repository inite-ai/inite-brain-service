# Contributing to INITE Brain Service

Thanks for opening this file — that's already 90% of the battle. This is a
working production service, not a hobby project, so the bar for changes is
"would I sign off on this PR if I'd never met you?" Here's what that means
concretely.

## Before you start

- **New here?** Browse [`good first issue`](https://github.com/inite-ai/inite-brain-service/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
  and skim the [Code of Conduct](CODE_OF_CONDUCT.md). PRs of any size are welcome.
- **Read the README** — § Why Brain, then the [architecture](docs/architecture.md)
  and [bitemporal](docs/bitemporal-semantics.md) docs. Brain is a *system of
  insight, not a system of record*. Understanding that distinction prevents 90%
  of "why did you reject my PR" exchanges.
- **Read the operator playbook** in `docs/operator-playbook.md`. The runbook
  is the lens through which prod issues get triaged; new features that
  break troubleshooting flows aren't free.
- **Skim the migrations** in `src/db/migrations/`. Numbered, append-only,
  every change to schema lands as a new file. They're a real-time diary of
  what we've shipped.
- **Look at the recent commit log**. Commit messages explain the *why* —
  they're the closest thing this repo has to ADRs.

## Setting up locally

```bash
# Clone + install
git clone git@github.com:inite-ai/inite-brain-service.git
cd inite-brain-service
pnpm install

# Bring up SurrealDB
docker compose up -d surrealdb

# Copy + fill env (you need OPENAI_API_KEY for ingest/search)
cp .env.example .env
$EDITOR .env

# Run
pnpm start:dev
```

If something breaks at setup, **file an issue** — that probably means our
onboarding docs are wrong. Don't suffer in silence.

## The four hard bars for a PR

### 1. Tests pass

Local:

```bash
pnpm test                          # unit suite (~5s, currently 485 cases)
pnpm test:e2e:real                 # testcontainers Surreal — slower (~30s)
```

CI also runs `pnpm test:eval` — the multi-vertical retrieval eval against
real OpenAI. It enforces hard thresholds (recall@1 ≥ 0.6, MRR ≥ 0.5,
memory-lifecycle = 1.0, etc.) and diffs against `.eval-baseline/main.json`.
A retrieval-quality regression beyond per-metric tolerance blocks merge.

If you touched anything in `src/jobs/`, run the real-Surreal jobs e2e:

```bash
pnpm test:e2e:real -- --testPathPattern=jobs.real
```

### 2. Migrations are append-only

`src/db/migrations/NNNN_description.surql`, numeric order, idempotent
(`IF NOT EXISTS` everywhere). **Never edit a shipped migration** — the
migrator tracks `migrationId` in each tenant's `schema_migrations` table;
once applied, the file is silently skipped on re-deploy. Edits to applied
migrations are invisible in prod. Add a new numbered file instead.

If your migration changes a column type or drops a field, you also need:

- A clear comment at the top of the file explaining the migration semantics
  (search the dir for an example — the existing files all have them).
- A note in the PR description on whether existing rows need backfilling,
  and how. The migrator doesn't backfill — that's a separate one-off
  script or runtime UPDATE inside the same migration.

### 3. No new dependencies without justification

Cold-start budget is tight — BGE-M3 already lugs ~150MB of ONNX, and
`onnxruntime-node` is the reason the Dockerfile is `node:22-slim` and not
`alpine`. A new top-level dep needs:

- A one-sentence reason in the PR description.
- A `pnpm-lock.yaml` diff that shows the actual transitive cost.
- A check that the dep doesn't pull in a native binary that breaks
  glibc / musl assumptions in the runtime image.

Prefer:
- Reimplementing 10-20 lines locally over a new dep that ships 200KB.
- Extending an existing dep's API surface over a "lighter alternative"
  that doubles the dep count.

Transitive deps from a dep we already have are free — that's why
`@opentelemetry/sdk-trace-base` is OK without listing it explicitly.

### 4. Commit messages explain the why

Bad:

> fix bug in dreams cron

Good:

> fix(dreams): cron skipped on leader transition because guard.run held
>
> The DistributedLeaseGuard wraps the body in a leader_lease lock with
> ttl=300s. When the cron tick fired during a leader change (acquire
> takes ~100ms under contention), the new leader saw the lease already
> held by the (now-departed) old leader and returned null. Tightening
> the ttl to 90s lets the failover happen within one cron cycle.

The body should answer "if I bisect to this commit six months from now,
will I understand what I'm looking at?" Phase / iteration tags
(`feat(jobs): Phase J part 2.1 — ...`) are encouraged for multi-commit
feature streams; see existing log for the convention.

Co-author trailers (e.g. `Co-Authored-By: Claude Opus 4.7 (1M context)
<noreply@anthropic.com>`) for AI-assisted commits are welcome and
expected — we keep the trail honest.

## What we don't accept

- **Backward-compatibility for hypothetical callers.** If you remove a
  field, remove it. Brain's API is versioned (`/v1/...`); we cut a `v2`
  if we need to evolve incompatibly.
- **Re-export shims for removed code.** Delete the import, delete the
  call site, delete the implementation. No `// removed in vN` comments.
- **Feature flags as a way to avoid making a decision.** If the new code
  is right, ship it on. If it's not, don't merge it. (Real A/B operator
  flags for eval-driven rollout are different — those are documented in
  README § Operations.)
- **Tests that mock out the part you're testing.** A unit test that
  mocks the conflict resolver to verify the conflict resolver is a
  tautology. Use real internals; the only legitimate mocks are external
  systems (OpenAI, Surreal in pure-unit tests, Cohere).
- **Quality regression without an explicit decision.** If your PR drops
  recall@1 by 2pp but adds a feature, the PR needs an explicit
  justification + a note in the operator playbook that the new feature
  is opt-in. The CI gate will block automatically.

## What we DO welcome

- **New predicates / vertical-specific evaluators.** Brain's vocabulary
  lives in `inite-ecosystem/core/capabilities/knowledge.yaml`; the
  resolver in this repo reads it. Adding a vertical means a PR to the
  spec repo PLUS a scenario file under `src/eval/scenarios/`.
- **Alternative embedders.** The `EmbedderProvider` interface in
  `src/ai/embedder/` is the seam. Wire a new provider, set
  `EMBEDDER_PROVIDER=<your-id>`, run the eval to prove it doesn't
  regress.
- **Bug reports with reproducible JSON directories.** The eval harness
  takes `BRAIN_DIRECTORY_JSON=…/your.json`. If you can produce a
  scenario where brain returns the wrong answer, that's a gold input
  for a regression test — open an issue + attach the JSON.
- **Operator runbook gaps.** `docs/operator-playbook.md` is where we
  capture "I had to figure this out the hard way" knowledge. PRs that
  add a missing troubleshooting section are unconditional yes.
- **Type-narrowing PRs.** If you find an `as any` or a `Record<string,
  unknown>` that shouldn't be there, tightening it is welcome.

## Releasing

Brain auto-deploys on push to `main` via `.github/workflows/deploy-brain.yml`
(self-hosted SFO runner builds + ships the image, restarts the container).
There's no semver release process for the service itself — every green main
commit is "released" to prod. The version field in `package.json` (`0.1.0`)
is decorative.

Rollback is via the workflow's `restart` action against a previous tag
(see `docs/DEPLOY.md` § Rollback).

## License

By contributing, you agree your changes ship under the project's existing
license — **GNU Affero General Public License v3.0 or later** (see
[`LICENSE`](LICENSE)).

In practice that means:

- Your contribution becomes AGPL-3.0 like the rest of the codebase.
- If you fork brain and host the fork for users over a network, you
  must make your modifications available to those users under AGPL-3.0.
- We won't relicense your contribution to a more permissive licence
  without your consent.

If your employer requires a CLA, open an issue — we'll figure out the
right shape together. The default-no-CLA stance is intentional; we'd
rather you stay in copyright control of your patches than build the
legal scaffolding for a corporate handoff that may never come.

## Questions

GitHub Issues and Discussions. No private Slack — public so the next
person Googling the same question can find the answer.
