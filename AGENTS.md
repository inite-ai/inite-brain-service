# AGENTS.md — contributing to INITE Brain

> Using Brain as your agent's memory? See [docs/agents-using-brain.md](docs/agents-using-brain.md).

This file is for AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini
CLI, Windsurf…) and the humans working with them on **this repository**. It is
the source of truth for commands, zones and the idea → PR loop.
[CONTRIBUTING.md](CONTRIBUTING.md) is the human-facing companion; where the two
disagree, this file wins (and please fix the other one).

## What this is

INITE Brain is a bitemporal, per-tenant knowledge-graph memory service for AI
agents, served over MCP (Streamable HTTP) and REST, on SurrealDB. NestJS 11 +
TypeScript, pnpm, Node 22. Also in the repo: the landing/admin app
(`brain-landing/`, Next.js), npm clients (`clients/*`), the agent skills
(`skills/`) and the Claude Code plugin (`plugins/inite-brain/`).

**Place in the INITE Triad:** Auth (inite-auth-service) issues tokens;
Billing and Brain verify them. The token contract (issuer, audience, claims)
is [inite-triad/docs/compatibility.md](https://github.com/inite-ai/inite-triad/blob/main/docs/compatibility.md);
Brain's side of it is `src/auth/token-audience.ts`, pinned by
`test/triad-token-contract.socket-spec.ts`.

## Ground rules (non-negotiable)

1. **Never edit a shipped migration.** Schema changes are a NEW file
   `src/db/migrations/NNNN_description.surql` (next free number, idempotent,
   `IF NOT EXISTS`). The migrator records applied ids per tenant and silently
   skips edited files, so an edit is invisible in production.
2. **Never weaken tenancy or per-user scope.** Every tenant is its own
   database (`NS=brain`, `DB=co_<companyId>`, reached only through
   `SurrealService.withCompany`). Omitting `userId` must keep returning
   tenant-global facts only — personal memory is never mixed in. No new code
   path may skip the scope fences (`src/auth/user-scope.ts`,
   `src/auth/tenant-scope.ts`, `src/search/internals/where-builder.ts`).
3. **Never change the token contract** (accepted `iss`/`aud`, claim shapes,
   scope names `brain:read|write|admin|read_pii|read_media|platform_admin`)
   without a Triad-level change agreed first.
4. **GDPR forget stays complete and synchronous.** `forget_entity` / user
   forget must keep cascading every derived row and leaving only tombstones.
   A new table holding user content must be wired into the cascade.
5. **No eval forks behind flags.** A flag whose purpose is to let one
   measurement see a different code path is a fork; forks live on git
   branches. Per-tenant behaviour is configuration (`RetrievalProfile`,
   extraction profile), not a flag. New engine-behaviour boolean flags fail
   `test/flag-budget.unit-spec.ts` until a maintainer approves the golden
   entry. Every catalogued flag must have a reader
   (`test/config-catalog-truth.unit-spec.ts`).
6. **Never log or echo secrets, API keys, tokens or memory content/PII.**
   Never commit `.env*` files or keys. Credentials stored at rest go
   through `src/common/secret-cipher.ts`.
7. **Never hand-edit generated files:** `docs/openapi.json` and
   `brain-landing/public/openapi.json` (`pnpm openapi:build`),
   `plugins/inite-brain/skills/` (`pnpm plugin:sync`),
   `src/data/skill-versions.json` + `src/data/skill-changelog.ts`
   (`pnpm skills:build`), `src/db/migrations/0135_flexible_reconcile.surql`
   (`pnpm migrations:flexible`), `CHANGELOG.md` and version numbers
   (release-please).
8. **Never skip or weaken a gate** — no `.skip`, no lowered coverage
   threshold, no raised lint warning cap, no deleted assertion to get green.
   A "truth" spec failing means the code and its claim disagree; fix one.
9. **No new dependency without a reason** in the PR body (cold-start and
   image size are tight; see CONTRIBUTING.md § 3).
10. **Real-model evals and paid API calls need the maintainer's OK** — they
    spend real money. Unit tests never call a model.

## Zones

| Path                                                                                   | What lives there                                                      | Zone                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| `docs/` (except generated), `examples/`, `brain-landing/content/`                      | Prose, guides, blog/docs MDX, runnable examples                       | 🟢 green                    |
| `test/*.unit-spec.ts` (new tests only)                                                 | Unit tests for existing behaviour                                     | 🟢 green                    |
| `src/mcp/`                                                                             | MCP tool registrations, profiles, annotations                         | 🟡 yellow                   |
| `src/*/**.controller.ts`, `src/contracts/`                                             | REST routes, zod wire contracts (additive changes)                    | 🟡 yellow                   |
| `src/search/`, `src/synthesize/`, `src/ai/`, `src/documents/`, `src/episodes/`         | Retrieval, answer generation, extraction, document pipeline           | 🟡 yellow (+ eval evidence) |
| `src/source-plane/`, `src/sources/`, `src/jobs/`, `src/dreams/`, other `src/*`         | Connectors, job queue, background passes, everything else             | 🟡 yellow                   |
| `clients/*`, `plugins/`, `skills/`, `brain-landing/` (app code)                        | npm clients, Claude Code plugin, agent skills, landing + admin UI     | 🟡 yellow                   |
| `src/db/migrations/`, `src/db/schema.surql`, `src/db/`                                 | Schema (append-only), migrator, tenant connection pools               | 🔴 red                      |
| `src/auth/`, `src/keys/`, `src/policy/` (engine)                                       | Token/API-key verification, audience, scopes, key minting, ABAC       | 🔴 red                      |
| `src/entities/*forget*`, `src/documents/document-purge.util.ts`                        | GDPR forget cascades                                                  | 🔴 red                      |
| `src/ingest/conflict-resolver.ts`, `src/ingest/fact-resolver.service.ts`, `src/facts/` | Conflict resolution, fact lifecycle (supersede / COMPETING / retract) | 🔴 red                      |
| `src/common/*-flags.ts`, `src/admin/config-catalog*`, `test/golden/`                 | Flag readers, config catalogue, flag budget                           | 🔴 red (new flags)          |
| `test/eval/**`                                                                         | Eval batteries, golden baselines                                      | 🔴 red                      |
| `.github/workflows/`, `scripts/ci/`, `Dockerfile`, `docker-compose*.yml`               | CI, deploy (every green `main` deploys to prod)                       | 🔴 red                      |
| Published API shapes (breaking changes to `src/contracts/`, MCP tool schemas)          | What integrators code against                                         | 🔴 red                      |

🟢 just do it · 🟡 tests + a note in the PR on what you touched and why ·
🔴 **stop**: open an issue with a spec (template "Product idea"), a maintainer
approves the design before code.

## Setup

**One click:** [Open in GitHub Codespaces](https://codespaces.new/inite-ai/inite-brain-service)
— `.devcontainer/` gives Node 22, pnpm 10, deps installed, a `.env` copied from
`.env.example`, SurrealDB running on `localhost:8000` and Docker-in-Docker for
the e2e suites.

**Local** (Node 22, pnpm 10 via `corepack enable`, Docker for SurrealDB):

```bash
pnpm install --frozen-lockfile
cp .env.example .env              # set OPENAI_API_KEY for ingest/search
docker compose up -d surrealdb    # SurrealDB v3.2.4 on localhost:8000
pnpm start:dev                    # http://localhost:3000/health
```

Creating a local API key: README § Run from source. Unit and socket tests need
no database, no Docker and no API key. The e2e suites start their own
SurrealDB container via testcontainers (`test/global-setup.ts`; set
`SURREALDB_URL` to reuse a running one). Landing app: `cd brain-landing &&
pnpm install --frozen-lockfile && pnpm dev` (port 3030).

## Commands

Mirrors [.github/workflows/ci.yml](.github/workflows/ci.yml) (CI installs with
`--ignore-workspace`; same lockfile).

| What                         | Command                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Install                      | `pnpm install --frozen-lockfile`                                                        |
| Dev server                   | `pnpm start:dev`                                                                        |
| Lint (CI)                    | `pnpm lint:ci` (zero warnings; `pnpm lint` auto-fixes)                                  |
| Format check (CI)            | `pnpm format:check` (fix with `pnpm format`)                                            |
| Typecheck src + tests        | `pnpm typecheck`                                                                        |
| Build                        | `pnpm build`                                                                            |
| Unit tests                   | `pnpm test` (CI: `pnpm test:unit:cov`, coverage ratchet)                                |
| One test file                | `pnpm test -- test/where-builder.unit-spec.ts` (or a name fragment)                     |
| Socket tests (loopback HTTP) | `pnpm test:socket`                                                                      |
| E2E (Docker)                 | `pnpm test:e2e` (CI shards: `pnpm exec jest --config ./test/jest-e2e.json --shard=1/4`) |
| Jobs e2e (Docker)            | `pnpm test:e2e:jobs`                                                                    |
| Landing (`brain-landing/`)   | `pnpm lint:i18n && pnpm lint:ci && pnpm typecheck && pnpm test && pnpm build`           |
| Regenerate OpenAPI           | `pnpm openapi:build`                                                                    |
| Sync plugin skills           | `pnpm plugin:sync` (`--check` reports drift)                                            |

CI jobs: `engine-checks` = `lint:ci` + `format:check` + `typecheck` + `build`;
`engine-unit`; `engine-socket`; `engine-e2e` (4 shards); `engine-jobs-e2e`;
`web` (landing); `docker`; `build-test` judges those; `supply-chain`
(`pnpm audit --audit-level=high`) is its own required check. The real-LLM
`quality-eval` (nightly) and `real-e2e` (manual dispatch) never run per PR.
`devcontainer.yml` builds `.devcontainer/` when it or the lockfile changes.

**Done = `lint:ci`, `format:check`, `typecheck`, `build`, `test`, `test:socket`
green locally, and every CI job green on the PR.** `format:check` is the one
people forget.

## Architecture map

Request flow: `src/main.ts` → `AppModule` (`src/app.module.ts`) → global
throttler → controller guarded by `ApiKeyGuard` (`src/auth/api-key.guard.ts`:
API key or Auth-service JWT → `req.brainAuth = { companyId, scopes, … }`) →
`@RequireScopes` + `@PolicyAction` (ABAC, `src/policy/`) → service →
`SurrealService.withCompany(companyId, …)` → tenant DB `co_<companyId>`.
MCP: `POST /mcp` or `/mcp/:companyId` → `src/mcp/mcp.controller.ts` →
`McpService` builds one MCP server per request with only the tools the
credential's scopes allow.

| Area             | Where                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write path       | `src/ingest/` (mentions, entity resolution, conflict resolver), `src/documents/` (Source → Indexer → Candidates), `src/episodes/` (raw substrate)               |
| Extraction       | `src/ai/extractor-*.ts`, `src/ai/extractor-internals/` (lanes), profile in `src/ai/extraction-profile.ts`, predicates in `src/ai/predicate-registry.service.ts` |
| Read path        | `src/search/` (legs, rerank, `retrieval-profile.ts`), `src/synthesize/` (answer lanes, verifier, citations), `src/multi-hop/`, `src/entities/`, `src/facts/`    |
| Background       | `src/jobs/` (Surreal-native queue), `src/dreams/`, `src/compaction/`, `src/communities/`, `src/scenes/`, `src/beliefs/`                                         |
| Connectors       | `src/source-plane/`, `src/sources/`                                                                                                                             |
| Operator surface | `src/admin/` (operator routes behind `brain:platform_admin`; tenant pack admin under `brain:admin`), config catalogue `src/admin/config-catalog/` (parts) |
| Wire contracts   | `src/contracts/` (zod; feed `docs/openapi.json` via `scripts/build-openapi.ts`)                                                                                 |
| Domain packs     | `src/ai/domain-packs/`, `packs/*.pack.json` ([docs/domain-packs.md](docs/domain-packs.md))                                                                      |

Engine layering is enforced by `test/engine-gates.unit-spec.ts`:
`episodes ← derive ← search ← synthesize` (no reverse imports), and no
`process.env` inside `src/search/`, `src/synthesize/`, `src/ai/extractor-*`
except `src/search/retrieval-profile.ts` — engine code takes the resolved
profile.

**Add an MCP tool:** register it with
`server.registerTool(name, { title, description, inputSchema }, handler)` in
the matching `src/mcp/*-tools.ts` (reads: `read-tools.ts`, writes:
`write-tools.ts`; a file near the 800-line lint cap gets a new sibling
`<family>-tools.ts` whose `register…Tools()` is called from **both**
`McpService.buildServer` in `src/mcp/mcp.service.ts` and
`src/mcp/gated-catalogue.ts`). A new service dependency is injected in the
`McpService` constructor and its module imported in `src/mcp/mcp.module.ts`.
Then: add the action to `ACTIONS` in `src/policy/action-registry.ts` (its
`kind` drives the ABAC gate and the MCP annotations) → decide on the `core`
profile (`src/mcp/tool-profiles.ts`) and `HEALTH_TOOLS` (`mcp.service.ts`) →
tests: add the name to the expected lists in `test/mcp-tools.unit-spec.ts`;
`test/mcp-tool-annotations.unit-spec.ts`,
`test/mcp-tool-descriptions.unit-spec.ts` (a description says what the tool
does, not what the model should do) and
`test/mcp-tool-schema-cost.unit-spec.ts` (use `isoDateTime()` from
`src/mcp/iso-datetime.ts`, not `z.string().datetime()`) must stay green; an
e2e like `test/mcp-fact-tools.e2e-spec.ts` → list it in
[docs/agents-using-brain.md](docs/agents-using-brain.md).

**Add a REST route:** controller in the feature dir with
`@UseGuards(ApiKeyGuard)`, `@RequireScopes('brain:read'|…)`,
`@PolicyAction('<name>')` (the MCP tool's name when one exists, else a
`rest.*` entry in `ACTIONS`; model: `src/facts/facts.controller.ts`), register it
in that module's `controllers` → request/response shape as a zod contract in
`src/contracts/<area>/` with a `test/contracts-*.unit-spec.ts` parity guard →
if integrator-facing, add the path in `scripts/build-openapi.ts` and run
`pnpm openapi:build` (`test/openapi-doc.unit-spec.ts` checks both copies) →
document in [docs/api.md](docs/api.md).

**Add a migration (red zone):** `src/db/migrations/<next NNNN>_<what>.surql`,
header comment explaining semantics and backfill, idempotent statements.
`src/db/schema.surql` is reference-only and not applied. Known SurrealDB
traps live in existing migration headers — read the last few first.

**Add an extraction lane:** pure module in `src/ai/extractor-internals/`
(model: `denoise.ts`, switched by `dropSaid`), wired in
`src/ai/extractor-runner.service.ts`, switched by a field on the extraction
profile (`src/ai/extraction-profile.ts`), never `process.env` in the lane. An
`EXTRACTOR_*` switch is an engine flag → flag budget golden + config catalogue
entry → maintainer approval, plus eval evidence
([docs/eval-methodology.md](docs/eval-methodology.md)).
Retrieval/answer lanes: `LaneId` in `src/search/retrieval-profile.ts` and
`LANE_REGISTRY` in `src/synthesize/answer-router.ts` (one entry per id, gated).

**Add an env var / flag:** read booleans only via `envFlagEnabled` /
`envFlagNotDisabled` (`src/common/env-validation.ts`); add a
`CONFIG_CATALOG` entry whose default matches the reader; document it in
`.env.example` and [docs/operations.md](docs/operations.md).

**Add a UI page:** `brain-landing/app/[lang]/…` (Next app router); admin
strings go through `getMessages()`, never JSX literals (`pnpm lint:i18n`).

## From idea to PR

The loop an agent runs **with** the human (in Claude Code: `/contribute`):

1. **Restate** the idea in plain words; ask at most 3 clarifying questions.
2. **Locate** it: which files, which zone (table above). Search issues
   (`gh issue list --search "<words>"`) — reuse an existing one.
3. **Spec** (short): problem · user-visible behaviour · API/MCP/UI change ·
   data change (migration?) · risks (tenancy, PII, cost, eval impact) · out
   of scope. **Red zone → STOP**: file it with the "Product idea" issue
   template, paste the spec, and wait for a maintainer.
4. **Plan** small steps, each leaving the build green.
5. **Implement with tests**, tests first where practical. Behaviour change in
   retrieval/extraction/synthesis: say which eval battery would measure it and
   ask before running a paid one.
6. **Run the gates** (Commands → Done).
7. **Docs:** update the doc that describes the behaviour (`docs/*.md`,
   `.env.example`, `docs/agents-using-brain.md` for the MCP surface). Never
   edit `CHANGELOG.md`.
8. **Commit** with Conventional Commits — release-please derives the version
   and changelog from them: `feat(scope): …`, `fix(scope): …`, `docs: …`,
   `test: …`, `refactor: …`, `perf: …`, `ci: …`, `chore: …`; `!` (e.g.
   `feat(api)!:`) for a breaking change. Body explains _why_. AI-assisted
   commits carry a `Co-Authored-By:` trailer.
9. **Open a PR** (`gh pr create`) with the template filled: a plain-language
   summary a non-engineer can follow, the zone, gates run, tests added,
   AI disclosure. The PR title must be a Conventional Commit
   (`pr-title.yml` checks it).

## Conventions

- **Style:** Prettier (single quotes, trailing commas, width 100) +
  type-aware ESLint (`eslint.config.mjs`): no `any`, no floating promises,
  `max-lines` 800, `max-lines-per-function` 200, `max-params` 3,
  `complexity` 25 in `src/`. `noUncheckedIndexedAccess` is on.
- **Naming:** kebab-case files by role — `*.service.ts`, `*.controller.ts`,
  `*.module.ts`, `dto/*.dto.ts`; pure helpers as plain `*.ts`. One class per
  file.
- **Comments:** docblocks explain _why_ (the incident, the measurement, the
  trap), not _what_. Match the density of the file you edit.
- **Errors:** throw Nest HTTP exceptions (`NotFoundException`,
  `ForbiddenException`, …); a disabled surface answers 404, indistinguishable
  from an absent route.
- **Logging:** `private readonly logger = new Logger(X.name)`; ids and counts,
  never memory content, keys or tokens.
- **Tests:** flat under `test/`, named `<topic>.unit-spec.ts`,
  `.socket-spec.ts`, `.e2e-spec.ts`, `.real-e2e-spec.ts`.
- **Branches:** `feat/…`, `fix/…`, `docs/…`, `ci/…`, `chore/…`. Small PRs; one
  concern each. Squash-merged with the PR title as the commit.
- **Commit subjects** read as the outcome: `fix(registry): a novel predicate
is registered once, however many reads coin it at once`.

## Testing

| Suite            | Pattern / config                                                         | Needs                                             |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| Unit             | `*.unit-spec.ts`, `test/jest-unit.json`                                  | nothing (no DB, no network)                       |
| Socket           | `*.socket-spec.ts`, `test/jest-socket.json`                              | loopback `listen()`                               |
| E2E              | `*.e2e-spec.ts`, `test/jest-e2e.json`                                    | Docker (testcontainers SurrealDB), stubbed models |
| Jobs e2e         | `jobs.real-e2e-spec.ts` via `pnpm test:e2e:jobs`                         | Docker; no model keys                             |
| Real e2e / evals | `brain.real-e2e-spec.ts` (`pnpm test:e2e:real`), `test/eval/*/runner.ts` | real provider keys, money — ask first             |

- Unit example: `test/where-builder.unit-spec.ts` (pure function).
  E2E example: `test/mcp-fact-tools.e2e-spec.ts` — `createApp()` from
  `test/app-fixture.ts` boots the app against the test DB with a unique
  `companyId`; restore any env you set in `afterAll`.
- Test doubles: `test/test-doubles.ts`; fixtures `test/fixtures/`; goldens
  `test/golden/`, snapshots `test/__snapshots__/`.
- Mock only external systems (OpenAI, Cohere, Surreal in pure unit tests) —
  never the thing under test.
- Many `*-truth.unit-spec.ts` specs pin docs, workflows and configs to the
  code. When one fails, the claim and the code disagree — fix the one that is
  wrong.
- Mechanical, judge-free batteries: `pnpm eval:memory-fitness`,
  `pnpm eval:state-transitions` ([docs/eval-methodology.md](docs/eval-methodology.md)).

## When to ask a human

- Anything in a 🔴 zone, or a change to a published API/MCP shape.
- A new dependency, env var, feature flag, or MCP tool.
- Running a real-model eval, the real e2e suite, or anything that costs money.
- A truth/golden spec fails and you are not sure which side is wrong.
- Tests or CI fail for reasons you cannot explain after one honest attempt.
- The idea conflicts with the docs (bitemporal semantics, "system of insight,
  not system of record", the no-eval-forks rule).
- Anything touching production, deploy, secrets or another tenant's data.

## Help

- Questions: [GitHub Discussions](https://github.com/inite-ai/inite-brain-service/discussions);
  bugs and ideas: [issues](https://github.com/inite-ai/inite-brain-service/issues/new/choose).
- Starter tasks: [`good first issue`](https://github.com/inite-ai/inite-brain-service/issues?q=is%3Aopen+label%3A%22good+first+issue%22).
- Human guide: [CONTRIBUTING.md](CONTRIBUTING.md) · docs hub:
  [docs/README.md](docs/README.md) · architecture:
  [docs/architecture.md](docs/architecture.md).
- Vulnerabilities: [SECURITY.md](SECURITY.md) — never a public issue.
