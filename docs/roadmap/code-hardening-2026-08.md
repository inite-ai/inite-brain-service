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

## Deliberately deferred (honest sizing, not skipped-and-forgotten)

These are real improvements but each is a dedicated campaign whose value is
undermined by doing it fast/carelessly. Scheduled, not hidden.

- **`exactOptionalPropertyTypes` (≈334 sites).** Distinguishes "key absent"
  from "key present = undefined". Real bug class, but each fix is a semantic
  judgment (absent vs undefined) across DTOs and object construction — lower
  bug-catching ROI than `noUncheckedIndexedAccess`, higher churn-per-value.
  Own PR.
- **`no-explicit-any` → error (≈213 `as any` casts + 69 `: any`).** ~50% are the
  SurrealDB row-result idiom (`db.query(...) as any`). The correct fix is typed
  row interfaces + generic `db.query<T>()` — an architectural improvement worth
  a focused effort. Flipping the rule without that work would mean ~213
  `eslint-disable` comments, which is worse than the current honest `off`. Own
  campaign. New code is already `any`-clean (the feature wave introduced none).
- **Coverage threshold — intentionally NOT added.** Unit-only coverage is
  misleading here: the 90-spec e2e suite (testcontainers) carries much of the
  real path coverage but its coverage isn't collected, and the architectural
  gate specs (`engine-gates`, `flag-budget`, `config-catalog-truth`, ~34
  contract guards) already pin the invariants a coverage number would only
  approximate. A unit-only ratchet would gate on a misleading metric and invite
  gaming. Revisit only with a combined unit+e2e coverage collector.

## Not gaps (deliberate design, recorded so they're not re-flagged)

- **Prettier / formatting is ungated.** ESLint is the chosen style authority;
  `prettier/prettier` is `off` by design. A repo-wide reformat would be
  cosmetic churn conflicting with real work — not added.
- **DB-level PII/ABAC fences are defense-in-depth**, not the primary control;
  the always-on enforcement is the JS layer, and boot validation
  (`env-validation.ts`) hard-errors in prod if the scoped pool that backs the
  DB fence is misconfigured — so the fail-open trap is closed. Don't market the
  DB fence as primary.
- **`strict: true` on branch protection (require up-to-date branches) kept
  off** — forces a re-run on every main advance for marginal value; rebasing
  before merge is already the workflow.
