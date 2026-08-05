# Memory is a profile of capabilities, not a speed

Status: adopted (owner-approved 2026-08-05). Evidence citations refer
to the eval program documented in [eval-protocol.md](eval-protocol.md)
and the roadmap results docs; numbers are paired-McNemar unless noted.

## The claim

Memory systems get compared the way engines get compared on a dyno:
one number per system, bigger is better. Every vendor leaderboard and
most papers work this way. The claim of this document is that the
scalar does not exist. A memory engine has no single quality; it has a
**capability profile** — a vector of abilities (verbatim recall,
cross-session aggregation, temporal reasoning, contradiction handling,
abstention, …) whose values are set by *mechanism choices*, and every
mechanism that raises one ability lowers another. A benchmark is not a
grade; it is a **genre** — a weighting over that vector. Optimizing
"the number" without naming the genre silently trades capabilities you
are not measuring.

This is not a philosophical position. We measured it, from both
directions, on one engine.

## The evidence

**Same engine, two profiles, 14.5pp apart — both correct.** On LoCoMo
dev-5 (diary-genre dialogues) the engine's shipping defaults — the
assistant-chat profile — score 62.1%. The same engine, same commit,
with the dialogue profile (open-vocabulary extraction, event-time
anchoring, episode substrate, derived windows, verbatim evidence
always on) scores 76.6% (p=1.2e-11 between them). Neither number is a
bug. Each profile is the right answer for its genre; the −14.5pp is
what it costs to read a diary with CRM glasses.
([validate-2026-08-results](roadmap/validate-2026-08-results.md))

**One mechanism, opposite signs by genre.** The segment lane
(retrieving composed conversational windows) was the single biggest
win in the LoCoMo lineage — and on LongMemEval assistant chats it
*costs* 28pp (80.0 lane-off vs 52 lane-on, p=5e-04), and on BEAM-100K
it more than halves the score (31.1 vs 12.5). The same code is the
best and the worst component we own, depending on corpus genre.
([locomo-sota-architecture](roadmap/locomo-sota-architecture-2026-07.md))

**The field measured the same law and named it.** Extraction
pipelines destroy single-session-assistant recall — old Mem0 scored
26.8 on SSA in the same harness where full-context scores 98.2, and
Mem0's 2026 rewrite (verbatim storage) took it to 98.2. Meanwhile
extraction is precisely what wins multi-hop and temporal reasoning
over raw context. Extraction vs verbatim is not better-vs-worse; it is
a capability trade the leaderboard scalar hides.
([lme-sota-research](roadmap/lme-sota-research-2026-08.md))

**The thesis predicted a measurement before it ran.** The V4 session
built one mechanism — verbatim segments as scored, citable retrieval
candidates ('fused') — and measured it the same day on two genres.
Diary (LoCoMo dev-5): +1.4pp over the appendix profile AND cheaper
(5550 vs 5745 prompt tokens), single-hop +2.6pp at p=0.08. Assistant
chats (LME SSA): −7.1pp at 2.3× the prompt. One commit, one mechanism,
opposite signs and opposite cost profiles by genre — the split this
document claims is structural, observed prospectively rather than
post-hoc. ([validate-2026-08-results](roadmap/validate-2026-08-results.md),
§ V4 confirm legs.)

**Even "the same memory" has no number.** With retrieval frozen,
swapping the reader model moves per-type accuracy by 7–31pp (Memoria:
knowledge-update 58.4 → 89.6 across readers; abstention 56.7 → 93.3).
A memory score that does not name the reader and the token budget is
not a measurement.

**Mechanism choices are profile choices all the way down.** Temporal
handled as a hard filter gives clean compliance and a recall cliff on
a bad asOf; interval-overlap scoring with distance decay (Hindsight,
91.0 TR) gives soft recall and fuzzier compliance. Neither is "the
fix"; they are two points on the strict↔soft axis, and different
tenants legitimately want different points.

## What this forces architecturally

**1. One engine; genres are configuration.** If capability profiles
are real, the engine must not fork per benchmark — a fork per genre is
how you end up with "measured-good components wired by flag history"
(the verdict of our own architecture audit). Capabilities live in
engine code, once. Genre selection lives in the per-tenant
**RetrievalProfile** — canonical keys, resolved per request, printed
into every eval report's provenance header. Forks are git branches
that die; profiles are the product surface. (This is the
no-eval-forks rule, now enforced by gates.)

**2. A benchmark score without a profile is noise.** Every eval
report carries the git SHA and the resolved profile of the run. "We
score X on Y" is meaningless until it reads "profile P scores X on
genre Y with reader R at T tokens/question." This is also how we
caught our own brief lying about a record config.

**3. Prefer question shape over deployment state.** Where a genre law
can be detected per-question (verbatim-shape questions pull episode
quotes regardless of lane flags), encode it in the router — one
tenant's mixed corpus then gets per-question behavior instead of a
tenant-wide compromise. Deployment-level genre pins are the fallback,
not the mechanism.

**4. Defaults are a genre pick and must say so.** There is no neutral
default. Our defaults are the assistant-chat profile; the deployment
env says `RETRIEVAL_GENRE=assistant_chat` as intent documentation, and
diary-genre evals MUST pin the dialogue profile. A default that does
not name its genre will eventually be mistaken for the engine itself —
that mistake cost us a 12pp phantom regression in V2.

**5. "SOTA" is a per-genre claim.** Parity with a leader means
matching them on their genre, their reader class, their token budget —
all three stated. Chasing a scalar across genres produces exactly the
flag archaeology this codebase spent a refactor digging out of.

## What it predicts

Falsifiable consequences we are willing to bet the roadmap on:

- A new mechanism that wins on one axis and is not measured on the
  other two will regress at least one of them. (History: every
  segment-lane, date-context, and ordering-frame leg.)
- Cross-genre "universal" gains exist but are rare and live in the
  engine's shared substrate (extraction fidelity, date normalization,
  reranking) — not in genre mechanisms. Those are the only changes
  that should ever touch defaults.
- A tenant-facing profile switch (diary vs assistant-chat) will
  outperform any single tuned default on a mixed customer base.
- Any eval leg whose report lacks a resolved-profile header will
  eventually be misread and cost a session of forensics. (History:
  twice.)

## The one-line version

We do not ship a memory speed. We ship a memory *engine* with a
measured capability surface, and tenants pick a point on it. The
benchmark table is a map of genres, not a podium.
