# Code-quality & security hardening (2026-08)

Record of the hardening pass that followed the two read-only audits (quality
gates + CI enforcement; security posture + feature-wave spot-check). The audits
found the gate surface **already written down and enforced** via the required
`build-test` check, the 8-PR SOTA feature wave **clean** (nothing slipped under
a default-off flag; answer-cache and L3 raw-context correctly re-apply the
user-scope/row-policy/PII fences), and a short list of genuine gaps. This pass
closed the gaps that close cleanly and honestly schedules the two that need a
dedicated campaign.

## Done

| Wave | Change | PR |
|---|---|---|
| W1 | Supply-chain CVE gate (`pnpm audit --audit-level=high --ignore-workspace`, runs regardless of repo visibility — scorecard/dependency-review no-op while private) + TruffleHog secret scan (`--only-verified`, SHA-pinned) + fixed a stale eslint comment that mislabeled the size gates "advisory" + removed a dead root jest config | #317 |
| W2 | `tsconfig` **`strict: true`** + `noImplicitOverride` — 34 mechanical fixes (27 DTO definite-assignment, 3 `override`, 4 variance), zero suppressions | #318 |
| W3 | **Type-aware ESLint** + `no-floating-promises`/`no-misused-promises`/`await-thenable` as errors — caught **2 real latent unhandled-rejection bugs** (async SIGTERM handler in `main.ts`; shutdown-ack in `job-worker-runner`). `no-floating-promises` count was 0. lint runtime 4.5s → 8.7s (well under budget) | #319 |
| W4 | **`noUncheckedIndexedAccess`** — 1131 sites (314 src ~65% real guards, 817 test sanctioned `!`). Caught **11 real latent bugs** (see below) | #320 |
| W5 | Branch protection: required checks now `build-test` + `supply-chain` + `trufflehog` + `lint` (conventional PR title). Was `build-test` only | (this doc) |

### The 11 latent bugs `noUncheckedIndexedAccess` caught

Genuinely reachable-undefined index accesses, previously unguarded:
`search-rerank`/`segment-lane` (malformed reranker permutation injected
`undefined` entities downstream), `openai-embedder` (empty response →
`vector: undefined` typed `number[]`; `sliceIdx[d.index]` → `out[undefined]`),
`reranker` (`candidates[parentIdx]` crash), `candidate-commit` (StatusUpdate
`id: undefined`), `aspect-rollups` (empty-members TypeError), `gate-train`
(feats/targets mismatch → NaN weights), `event-time` (dynamic `PARSERS[lang]`
→ chrono `undefined`), `admin-jobs` (`tenants[0]` → `companyId: undefined` into
job start, now 400s), `intent-classifier` (`scores[qIdx]` → NaN confidence),
`changefeed-drain` (`batch[last]` at limit 0).

## Done — second pass (the "no deferrals" follow-through)

The three items below were initially scoped as dedicated follow-up campaigns;
they were then all completed in the same session. Recorded here as done.

| Wave | Change | PR |
|---|---|---|
| W6 | **`no-explicit-any` → error.** All 421 src violations eliminated (~213 `as any` + ~73 `: any` + `any[]` generics across 66 files → 0). Added `queryRows<T>`/`queryFirst<T>` in `surreal.service.ts` (replacing the ~107 `db.query(...) as any` idioms with typed row interfaces) + `asStructuredContent()` for MCP; `unknown` + narrowing elsewhere. Zero remaining disables, zero laundering. Tests exempt via the test-override block | #322 |
| W7 | **`exactOptionalPropertyTypes`.** All 427 fixed (314 src + 113 test, 184 files): ~414 surgical widen-to-`\| undefined` (DTO/wire shapes), 106 conditional-omit (object construction), 3 restructure, 2 documented `as Transport` (the MCP SDK's own `.d.ts` is self-inconsistent under the flag). Behavior-adjacent key-omissions verified safe (no Surreal UPDATE changed to omit a field it used to null out) | #324 |
| W8 | **Coverage ratchet.** All-src `coverageThreshold` (statements/lines 52%, branches 40%, functions 45% — a few points under the current ~57/45/50/58), `collectCoverageFrom` excluding workers/main/modules/DTOs/migrations, `test:unit:cov` script + CI `--coverage`. A backslide guard; still unit-only (e2e path coverage not collected — documented in the config) | #323 |
| W9 | **Prettier gate.** Normalized 767 files to `.prettierrc` + `format:check` CI step. ESLint owns correctness, Prettier owns layout. Surfaced + fixed one real issue: reflow pushed `synthesize()` to 202 lines over the size gate → extracted `buildPrepareOpts()` | #325 |

## Not gaps (deliberate design, recorded so they're not re-flagged)

- **DB-level PII/ABAC fences are defense-in-depth**, not the primary control;
  the always-on enforcement is the JS layer, and boot validation
  (`env-validation.ts`) hard-errors in prod if the scoped pool that backs the
  DB fence is misconfigured — so the fail-open trap is closed. Don't market the
  DB fence as primary.
- **`strict: true` on branch protection (require up-to-date branches) kept
  off** — forces a re-run on every main advance for marginal value; rebasing
  before merge is already the workflow.
