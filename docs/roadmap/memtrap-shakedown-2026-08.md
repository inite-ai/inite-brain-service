# MemTrapBench-style trap-resistance shakedown (2026-08)

Companion write-up for `test/memtrap-shakedown.e2e-spec.ts`.

## What this is

A **free, deterministic, offline** e2e diagnostic that maps our
**structural** exposure to the four "memory traps" of MemTrapBench
(arXiv 2608.20202) — the finding that even _faithfully-recorded,
semantically-relevant_ memory can DEGRADE the current task (a trap =
answer-with-memory scores worse than answer-without).

It is a **plumbing + defense-firing** diagnostic, a sibling of the
memory-injection red-team suite (`memory-injection-redteam.e2e-spec.ts`,
G5) and the fovea cascade shakedown (`fovea-cascade.e2e-spec.ts`, #328).

## What it CANNOT do (read first)

The generator + verifier are **scripted stubs** (`mockSynthesizeOpenAi`)
and the embedder/extractor are deterministic doubles. So the suite
**cannot** measure whether a real LLM's reasoning degrades under trap
memory (that needs a real model = paid eval = out of scope). **No
accuracy/quality claim is made.** For each trap class it asserts only
(a) exactly what trap material reaches the generator prompt and which
lanes fire, and (b) which structural defense engages. Where behavior is
an exposure, the test asserts _that reality_ and labels it — it never
pretends we resist a trap we don't.

## Per-class result

| #   | Trap (family)                       | Lane-carrier                    | What reaches the prompt                                                                                                            | Defense that fires                                                             | Verdict                                                                    |
| --- | ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | Task Boundary (Reasoning Fixation)  | instruction lane + answer cache | task-A format rule elevated into task-B's generator prompt as an OBEY-this **Standing instructions** section (unconditional probe) | **answer cache** exact-match key (changed query never serves the prior answer) | **PARTIAL** — cache resisted-by-construction; instruction lane **exposed** |
| 2   | Cognitive Bias (Reasoning Fixation) | strategy lane (G4)              | the "do" strategy for problem A, in the fenced ADVISORY section, generator-only                                                    | none structural (G4 parity exception keeps it out of the verifier)             | **EXPOSED** (invisible to the verifier)                                    |
| 3   | Trauma (Reasoning Fixation)         | strategy lane (avoid-polarity)  | an `[AVOID]` advisory discouraging the strategy that is correct now, generator-only                                                | none — the contradiction lane fires only on COMPETING facts in one slot        | **EXPOSED**                                                                |
| 4   | Belief Distortion / Safety          | cited evidence fact + verifier  | the counterfactual premise, cited, in BOTH generator and verifier bundles (evidence parity)                                        | verifier — but it checks GROUNDING, not TRUTH, so it **passes** the cited trap | **EXPOSED** (key finding)                                                  |

## The two exposures to carry forward (for §4.3 + a future verifier arm)

1. **Belief-distortion verifier gap (class 4).** The corrective-RAG
   verifier judges whether every claim is _grounded in the cited
   evidence_, never whether the evidence is _true_. When the trap fact IS
   the cited evidence, an answer that restates it verifies as
   `supported` and is served. This is by design — contrast red-team
   scenario 10, where a **zero-citation** fabrication fails closed. The
   difference is citation-grounding; truth/plausibility is never in
   scope. A truth-or-plausibility check would be a **distinct** defense
   the current verifier does not provide.

2. **Strategy-lane fixation is invisible to the verifier (classes 2, 3).**
   By the deliberate G4 parity exception (advice-not-evidence), strategy
   notes reach the generator only — never the verifier, never citations.
   That correctly stops an advisory note from _grounding_ an unsupported
   claim, but it also means a strategy-**induced** fixation (bias or
   trauma) cannot be caught by the grounding audit: the auditor never
   sees the note that steered the answer.

Both feed the §4.3 suppression-governor design: a per-class signal that
could _down-weight or drop_ a lane's contribution (standing instruction /
strategy note / cited premise) when it is off-task for the current query.

## Notes on the harness (honest scoping)

- **Task Boundary, dual reach-path.** In this small corpus the search has
  no relevance floor and the user's fact pool is below `limit`, so the
  raw instruction _fact_ also co-retrieves into the evidence (verifier
  included). The test therefore asserts on the obey-**framing**
  ("Standing instructions:"), which is unambiguously produced by the
  lane and is **generator-only**. At production scale an unrelated
  instruction fact ranks out of top-`limit`, and the **unconditional**
  lane is then the only guarantee the rule still reaches the prompt.
- **Stub-embedder modeling.** `StubEmbedder` is text-exact; strategy
  retrieval matches when the note's key (title, empty situation)
  coincides with the spring query. That coincidence models the embedding
  proximity that, in production, carries an A-strategy onto a
  surface-similar problem B. The _plumbing_ finding (reaches generator /
  stays out of verifier+citations) is independent of why retrieval
  matched.

## Reproduce

The spec lives inside a git worktree, whose path (`.claude/worktrees/…`)
is in `jest-e2e.json`'s ignore patterns — override BOTH to run it:

```
npx jest --config ./test/jest-e2e.json --runInBand \
  --testPathPatterns memtrap-shakedown \
  --testPathIgnorePatterns /node_modules/ \
  --modulePathIgnorePatterns /node_modules/
```

Docker is required (ephemeral SurrealDB testcontainer). 4 scenarios, all
green; no `src` change, no new flags, no migration.
