# Next session: prove the refactor, ship it

The platform directive is executed (S1-S5, 31eec33..f0395ee — see
next-session-platform-2026-08.md, now stamped EXECUTED): seven dead
forks deleted with their code, winners folded into the single path,
RetrievalProfile + Lane registry + ExtractionPipelineProfile live, the
deriver writes through fn::resolve_fact (migration 0079), six gates
green. What landed is 1782 unit tests deep — and zero paid/live evals
wide. This session closes that gap and takes the branch to prod.

## V1 — self-describing reports (the missing measurement piece)

The one item of the directive's "how measurement works after this"
section that was NOT built: the eval harness must record the **git
SHA** (+ dirty flag, branch, resolved RetrievalProfile) in every report
header, so "which code produced this number" stops being tribal
knowledge. One shared helper in test/eval/harness/, consumed by
run-locomo / run-longmemeval / run-beam. Do this FIRST — V2's reports
should already carry it.

## V2 — equivalence smoke on all three axes

The refactor claims behavior-preservation for the default paths and
deliberate improvement where measurement said so (fact-centric always
on, local reranker capability). Prove it paired, not vibes:

- **LoCoMo dev-5** with the LoCoMo profile expressed the NEW way
  (RETRIEVAL_DATE_ANCHORING=none instead of SYNTHESIZE_DATE_CONTEXT=0;
  no other pins) vs the pre-refactor baseline report. Paired McNemar
  via scripts/eval-analysis. Expect n.s.; investigate any p<0.1.
- **LME smoke** (~50q slice, the lane-OFF protocol that scored 80.0):
  profile-off default engine. Expect parity or better (the S2 rerank
  capability is now on where it was off in some legs — if that shifts
  numbers, that is the MEASURED default now; record it).
- **BEAM-100K spot** (~100q): the B0-winning config re-expressed as a
  profile; gate is "no collapse", 55.0-config sanity held.

Leg-driver gotchas live in engine_wave_2026-08-03 memory (keys from ps
eww not .env, forced restart on attempt 1, stall watchdog). Eval legs
that used deleted flags (LANES_DISABLED ablations, --asof-policy) are
gone by design — do not resurrect them; per-tenant lane subsets go
through RETRIEVAL_PROFILE_OVERRIDES.

## V3 — merge + prod

1. Rebase/merge feat/locomo-llm-judge → main (it carries months of
   eval machinery; review the diff surface for anything eval-only that
   should not deploy — INGEST_EPISODE_ONLY etc. are flags, fine).
2. Apply migration 0079 to prod (shared 3.1.5; 0079 is
   OVERWRITE-idempotent, no data rewrite; old resolve_fact callers are
   updated in the same deploy — TS call site and fn ship together).
3. Deploy env diff: delete the removed keys from prod env (they are
   inert but lie), set the canonical profile keys where the deploy
   relied on legacy derivation. docs/operations.md already reflects
   the new surface.
4. Post-deploy: /metrics sanity (rerank invoked-rate will RISE — the
   capability fold turns the LLM reranker on wherever an OpenAI key
   exists; budget/margin-skip bound it, but watch
   brain_search_rerank_total and OpenAI spend for a day).

## V4 — carried audit items (fold in as time allows)

Still open from engine-architecture-audit-2026-08.md, unchanged by the
refactor: temporal overlap boost; verbatim as a fusion leg in
SearchHit; entity-expansion rewrite; releasing the scoped connection
across LLM awaits; segment/aggregate version columns + staging-swap;
dreams version-awareness. Also: shrink the S5.2 env allowlist further
(the remaining src/search infra readers → one search bootstrap module).

## Sequencing

V1 (small) → V2 (paid, run legs in background while doing V3 prep) →
V3 merge+deploy gated on V2 not collapsing → V4 with leftover time.
