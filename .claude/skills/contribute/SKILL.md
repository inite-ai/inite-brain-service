---
name: contribute
description: Take an idea for INITE Brain from plain words to a green pull request. Use when someone says "I have an idea", "I want to add / change / fix something in Brain", "make Brain do X", or asks how to contribute — engineer or not.
---

# /contribute — idea to PR for INITE Brain

You are pairing with someone who may not be an engineer. The repo supplies
the judgment: **AGENTS.md** at the root is the source of truth for zones,
commands and conventions — read it now if it is not already in context.

Throughout: **explain what you are doing in plain language as you go** —
one or two sentences per step, no jargon without a gloss ("a migration —
a numbered file that changes the database layout"). Ask before anything
that costs money, touches production, or changes a red zone.

## 1. Understand the idea

- Restate it back in plain words: "So you want … so that …".
- Ask **at most 3** clarifying questions, only ones whose answer changes
  what gets built (who it is for, what they see, how we know it works).
- If it is really a question about _using_ Brain as memory, point to
  `docs/agents-using-brain.md` instead.

## 2. Find where it fits

- Locate the code using the **Architecture map** in AGENTS.md
  (MCP tool → `src/mcp/*-tools.ts` + `src/policy/action-registry.ts`;
  REST route → a `*.controller.ts` + `src/contracts/`; extraction lane →
  `src/ai/extractor-internals/`; UI → `brain-landing/app/[lang]/`).
- Classify the **zone** from the AGENTS.md table: 🟢 / 🟡 / 🔴.
- Check for an existing issue: `gh issue list --search "<key words>" --state all`.
  Reuse it if it exists; mention `good first issue`s if one matches.

## 3. Write a short spec

Show it to the human and get a yes:

```
Problem:            what hurts today, for whom
Behaviour:          what the user/agent will see or be able to do
API / MCP / UI:     new or changed tool, route, field, page (or "none")
Data:               new table/field → new migration? (or "none")
Risks:              tenancy / per-user scope, PII, GDPR forget, cost, eval impact
Out of scope:       what we are deliberately not doing
How we'll know:     the test(s) that prove it
```

**🔴 Red zone → STOP HERE.** Migrations, `src/auth/`, `src/keys/`,
`src/policy/` engine, GDPR forget, conflict resolver / fact lifecycle, new
feature flags, eval batteries, CI/deploy, or a breaking API change. Tell the
human, in plain words, why this needs a maintainer first, then file the spec:

```bash
gh issue create --label idea --title "<plain-language title>" --body-file spec.md
```

(or open <https://github.com/inite-ai/inite-brain-service/issues/new?template=product-idea.yml>
and paste the spec into its "Spec" field).

Do not write code for a red-zone idea until a maintainer approves the design
on the issue. A new MCP tool, env var or dependency also needs a human yes.

## 4. Plan

Break the work into small steps, each leaving the build green. Say the plan
in one short list. Create a branch: `git switch -c feat/<short-name>` (or
`fix/`, `docs/`).

## 5. Implement with tests

- Tests first where practical. Unit specs go flat in `test/` as
  `<topic>.unit-spec.ts` (example: `test/where-builder.unit-spec.ts`);
  DB-backed behaviour as `<topic>.e2e-spec.ts` with `createApp()` from
  `test/app-fixture.ts` (example: `test/mcp-fact-tools.e2e-spec.ts`).
- Follow the recipe in AGENTS.md for the thing you are adding (MCP tool,
  REST route, lane, flag). Respect the ground rules — never skip the
  `userId` / tenant fences, never log memory content or secrets, never
  hand-edit generated files.
- Retrieval / extraction / synthesis behaviour: name the eval battery that
  would measure it and **ask** before running any paid one.

## 6. Run the gates

```bash
pnpm lint:ci
pnpm format:check      # fix with: pnpm format
pnpm typecheck
pnpm build
pnpm test
pnpm test:socket
```

E2E (`pnpm test:e2e`, `pnpm test:e2e:jobs`) needs Docker — ask before
running locally; CI runs them on the PR. Landing changes: run the
`brain-landing/` commands from AGENTS.md. Report results in plain words.
If a `*-truth.unit-spec.ts` fails, explain which claim and which code
disagree before changing either.

## 7. Docs

Update whatever describes the behaviour: `docs/*.md`, `.env.example`,
`docs/agents-using-brain.md` (MCP surface), `docs/api.md` (REST),
`pnpm openapi:build` if a published route changed. Never edit `CHANGELOG.md`.

## 8. Commit

Conventional Commits; the subject reads as the outcome, the body says why:

```
feat(mcp): a tool that lists an entity's open questions

<why this is needed, what it changes, what was considered>

Co-Authored-By: <your agent> <noreply@…>
```

`feat` / `fix` / `docs` / `test` / `refactor` / `perf` / `ci` / `chore`;
`!` after the type for a breaking change. release-please builds the version
and changelog from these.

## 9. Open the PR

```bash
git push -u origin HEAD
gh pr create --fill-first   # then edit the body to fill the template
```

Fill `.github/PULL_REQUEST_TEMPLATE.md`: plain-language summary (a
non-engineer should follow it), zone (link the approved issue for red),
gates run, tests added, AI-assisted disclosure. The PR title must be a
Conventional Commit. Then watch CI (`gh pr checks --watch`) and fix
failures. Do not merge — a maintainer reviews and merges.

Finish by telling the human, in two or three sentences, what changed, how it
was tested, and what happens next.
