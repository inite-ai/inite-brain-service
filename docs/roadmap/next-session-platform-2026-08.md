# Next session: kill the forks, make the engine modular

> **STATUS 2026-08-03: EXECUTED.** All five stages landed on
> `feat/locomo-llm-judge` (31eec33..4431605), 1782 unit tests green.
> S1 seven dead forks deleted with their code paths; S2 six winners
> folded (fact-centric is the path, backfill deleted, rerank is a
> capability); S3 RetrievalProfile resolved once in ApiKeyGuard +
> first-class Lane registry (synthesize is env-free); S4
> ExtractionPipelineProfile + migration 0079 (derivedVersion slot in
> fn::resolve_fact — the deriver writes through the one primitive);
> S5 all six gates live (flag budget golden 36 keys, env boundary
> allowlist, boolean idiom, layering, dead exports, lane registry).

Owner directive (2026-08-03): **stop shipping eval forks behind flags.**
A flag that exists so one measurement could see a different code path is
not a feature — it is a second engine we now maintain, test, and reason
about forever. Git is the fork mechanism. If a leg needs different
behavior, it runs on a branch; if the branch wins, the behavior becomes
the code; if it loses, the branch dies with it. Nothing merges to main
carrying its own alternative universe.

Consequences that are NOT negotiable next session:

1. Every behavior fork in the engine core gets deleted — either promoted
   to the single code path or removed outright.
2. What survives is **configuration**, not forks: typed per-tenant
   profile values (a number, an enum, an on/off capability), resolved
   once per request, never `process.env` reads scattered in hot code.
3. New forks are blocked by gates, not by discipline. Where the gate
   does not exist yet, build it in the same session.

## Where we are

163 catalogued env keys; **73 of them are engine-behavior flags**
(SEARCH_ 34, SYNTHESIZE_ 13, EXTRACTOR_ 12, INGEST_/EPISODE_/DERIVER_
rest). The 2026-08-03 architecture audit
(docs/roadmap/engine-architecture-audit-2026-08.md) already showed what
that costs: the shipped default path is "flag history, not design", our
own eval config silently voided the reranker and `limit`, and three
extraction tracts produce incompatible data for one `predicate` column.

## S1 — delete what measurement already killed (pure subtraction)

| Flag | Verdict | Action |
|---|---|---|
| `SYNTHESIZE_ORDERING_FIRST_MENTION` | LOSER (tau_norm 0.378→0.174, binary EO 7.5→0.0) | delete flag + first-mention sort + bare-list frame; keep `mentionDates` only if a consumer remains |
| `SYNTHESIZE_TEMPORAL_EVENT_INTERVALS` | NULL on BEAM (p=1.0) | delete flag + interval table + its prompt section + the `--asof-policy` runner branch |
| `SYNTHESIZE_LANES_DISABLED` | ablation machinery | delete entirely — ablation is a branch, not a runtime token list |
| `SEARCH_OCCLUSION_ENABLED` (+3 knobs) | +0.7pp p=0.57 (n.s.) | delete unless it earns a place as a profile value with a measured win |
| `SEARCH_HYPE_ENABLED`, `SEARCH_QUERY_EXPANSION_ENABLED`, `SEARCH_PREDICATE_ROUTER_ENABLED` | default-off, never measured to a verdict | delete the code or measure once on a branch, then fold/delete |

Deletion means the code path too. A flag left at `=0` with its branch
still compiled in is the same disease with better manners.

## S2 — fold the winners into the single path

These are default-ON today, i.e. the fork exists only to let someone
turn the engine back into its worse self:

- `SYNTHESIZE_ROUTER_LEXICON_V2` → the lexicon IS v2. Delete.
- `SYNTHESIZE_VERBATIM_EXCERPTS` → verbatim-shape conditioning is the
  behavior. Delete the flag; the genre dimension moves to the profile
  (below), not to an env toggle.
- `MULTI_HOP_SYNTH_EVIDENCE_UNION` → union is how multi-hop hands off.
- `SEARCH_FACT_CENTRIC_ENABLED` → this is our eval configuration and
  (post-W4) the better selection; make it the path and delete the flag,
  keeping `SEARCH_FACT_CENTRIC_BUDGET` as a profile number.
- `SEARCH_EDGE_EXPANSION_ENABLED` → already default-on with a bespoke
  `=== '0'` parse. Fold.
- `SEARCH_CROSS_ENCODER_ENABLED` / `_LOCAL` / `SEARCH_RERANKER_ENABLED`
  → capability, not fork: rerank when a provider is available (vendor
  key present, or the local worker loads), else skip. No flag.

## S3 — one profile object replaces the genre flags

The engine is genre-dependent (segment lane helps diaries, ruins
assistant chats; date arithmetic helps LongMemEval, hurts LoCoMo). That
is real, and it is **configuration per tenant**, not a process-global
fork. The precedent already exists and works: `PackExtractionProfile`
threads per tenant by argument.

    interface RetrievalProfile {
      genre: 'dialogue' | 'assistant_chat' | 'documents';
      verbatimEvidence: 'off' | 'shape_conditioned' | 'always';
      dateAnchoring: 'none' | 'session_date' | 'absolute';
      factBudget: number;
      quotesPerPrompt: number;
      lanes: ReadonlySet<LaneId>;
    }

- Resolved once in the guard next to `brainAuth`, passed as an argument
  (controller → search/synthesize → lanes). No `process.env` below the
  resolution point.
- `SYNTHESIZE_DATE_CONTEXT`, the four verbatim-lane flags
  (`SEARCH_EPISODIC_LANE_ENABLED`, `SYNTHESIZE_SOURCE_EXCERPTS`,
  `SEARCH_SEGMENT_LANE_ENABLED`, plus the shape default), every `_TOPK` /
  `_CAP` / `_LIMIT` number: all become fields here.
- Env keeps exactly one job: the **default profile** at boot.

Lane, likewise, becomes a first-class object (audit #27 — adding a lane
is 14 edits across 5 files today, and two parallel lane type systems
coexist):

    interface Lane {
      id: LaneId;
      detect(q: string): boolean;
      probe?(q: string, hits: SearchHit[]): SearchDto | null;
      transform?(evidence: SearchHit[], ctx: LaneCtx): SearchHit[];
      instruction(ctx: LaneCtx): string;
    }

One registry array; the prompt builder, the probe runner and the
evidence transform all iterate it. Adding a lane = one file.

## S4 — one extraction pipeline

Three tracts (closed-vocab span-grounded / open dialogue / aspect-slug
deriver) write three incompatible shapes into one `predicate` column
(audit #1-#4). Target: ONE pipeline whose *vocabulary* and *value shape*
are profile inputs, and one write primitive for every producer —
including derived worlds (needs a `derivedVersion` slot in
`fn::resolve_fact`, its own migration). `EXTRACTOR_DIALOGUE_PROFILE`,
`EXTRACTOR_ROUTING_ENABLED`, `EXTRACTION_OBJECT_NORMALIZE`,
`DERIVER_ASSISTANT_CONTENT` all disappear into that pipeline's config.

## S5 — gates, so this cannot regress

Existing (keep): OpenAPI drift, config-catalogue truth (dead keys,
`runtimeMutable` vs boot capture, boolean defaults), NUL bytes,
max-lines / complexity, unknown-lane-token boot refusal.

To build next session:

1. **Flag budget** — a golden file lists every engine-behavior env key.
   The count may go DOWN silently; adding one fails the gate. Forces a
   deliberate decision instead of a quiet fork.
2. **No `process.env` below the profile boundary** — `src/search`,
   `src/synthesize`, `src/ai/extractor-*`, `src/admin/window-deriver`
   may not read `process.env` directly; they take the resolved profile.
   Allowlist only for bootstrap resolution.
3. **One boolean idiom** — fail on `=== 'true'` / `=== '1'` /
   `!== 'false'` outside `env-validation.ts` (W6 fixed the instances;
   the gate keeps them fixed).
4. **Layering** — dependency direction is enforced: episodes/substrate
   ← derive ← search ← synthesize; no reverse imports, no deep imports
   across module internals.
5. **Dead exports** — an exported symbol with zero non-test consumers
   fails (the audit found four in one directory).
6. **Lane registry completeness** — every `LaneId` has exactly one
   registry entry and one instruction; no lane may be referenced from a
   second type union.

## How measurement works after this

Forks were the only mechanism we had for "compare A vs B in one
binary". The replacement, which is also what makes results honest:

- The change lives on a branch (or a worktree). The runner records the
  **git SHA** in the report header — reports become self-describing,
  and "which code produced this number" stops being tribal knowledge.
- Paired McNemar runs between two report files
  (`scripts/eval-analysis/`), exactly as this session did.
- Genre differences that are REAL behavior (LoCoMo session dates vs
  LongMemEval absolute dates) are profile values, so an eval leg sets a
  profile, not a code path.

## Sequencing

S1 and S2 are subtraction and can land the same day (delete + tests +
one green suite). S3 is the real refactor and should land as: profile
type + guard resolution + one consumer migrated (synthesize), then the
rest. S4 follows S3 (it needs the profile). S5 gates land alongside the
wave they protect — the flag-budget gate FIRST, so S1/S2 deletions
lock in.

Carried from the architecture audit (still open, fold into the above):
derived writes through `fn::resolve_fact`; temporal overlap boost;
verbatim as a fusion leg in `SearchHit`; entity-expansion rewrite;
releasing the scoped connection across LLM awaits; segment/aggregate
version columns + staging-swap; dreams version-awareness.
