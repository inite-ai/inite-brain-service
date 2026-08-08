# V8 session results — insight layer + the BEAM gap (2026-08-07/08)

Protocol: docs/roadmap/next-session-v8-2026-08.md. Mode: per owner
directive, build-everything-first (all five blocks landed as
default-off profile points behind PRs), then one sequential
measurement queue on loco-321. Stand: SurrealDB 3.1.5, judge
gpt-4.1-mini, provenance in every report header.

PRs: #255 (dependabot sweep, merged), #256 (operator_action datetime,
merged), #257 (verbatim routed fixes, merged), #263 (js-yaml, merged);
#258 insight lane → #259 timeline evidence → #262 salience scoring
(stacked, open — each carries its leg verdict as a PR comment).

## §0 — gate ack

DERIVER_COMPLETION_PASS stays in
test/golden/engine-behavior-flags.golden.json: per-tenant
write-profile configuration next to its class precedent
DERIVER_ASSISTANT_CONTENT, not an eval fork. (Same session adds
DERIVER_SALIENCE_STAMP under the same doctrine — owner review rides
PR #262.)

## §3b — routed SSA arm: null by mechanism → two live defects → fixed

The V7 confirm arm (lme-ssa-v7routed, n=56 vs lme-ssa-v4control) came
back BIT-IDENTICAL to control: 48.2% == 48.2%, 0/56 discordant,
control-level prompt tokens. The dispatcher never fired. Two live
defects on main:

1. **'routed' was unreachable**: #252 added it to the profile enum
   but not the strict boot validator — the env refused to boot.
2. **The lexicon missed its genre**: VERBATIM_PATTERNS matched
   interrogatives ("what did you say…") = 2/56 of the SSA slice; the
   dominant SSA phrasing is recall-shaped ("remind me of the
   restaurant you recommended"). Extension (you-<past-verb> anchor
   without me/us + "remind me"): 46/56 recall at 0/316 false
   positives across SSU/TR/MS and 0/999 on LoCoMo dev-5.

Both fixed in PR #257 (merged). Confirm re-run lme-ssa-v8lex:
**51.8% @ 8768 tok** vs control 48.2% @ 4862 (fusedcap ceiling 55.4%
@ 8591). Routing now fires mechanically — the token profile matches
the fused arm. Effect +3.6pp, pairs 9-7, p=0.80 — n=56 cannot
resolve it; vs fusedcap 11-13. **Verdict: mechanism confirmed,
effect n.s.; stays default-off.** By construction routed protects
SSU/TR (fused measured −10.0/−8.3 there) while giving SSA the fused
path; only a bigger-n slice can confirm the +pp.

## §3a — completion-pass fresh-version confirm: NULL

Leg w8cp: fresh tenant locow8, worktree pinned main a4ac9e0, the
verified w3d diary write env PLUS DERIVER_COMPLETION_PASS=1, full
dev-5. The cleanest ewave pair of the program — same write code, only
the pass differs.

Write side: segments BIT-EQUAL w3d (1286); propositions 1880 vs 1837
(+43, +2.3% — the completion pass's own additions); 5/5
conversations, 0 drops. (Stand OOM'd overnight mid-derive on attempt
1; the chain was killed before its re-ingest attempt — pair purity
kept — and a manual force re-derive completed the world.)

QA pair (762 judged each, McNemar over 998 rows): **76.1% vs 77.0%,
discordant 134 (64 w8cp / 70 w3d), p=0.67 — a statistical tie.**
Per-category deltas are noise; prompt tokens flat.

**Verdict: NULL.** The +2.3% extraction-recall gain does not move
dev-5 QA. ~2× deriver spend buys nothing measurable on this genre;
the flag stays default-off configuration; the held-out record attempt
via completion-pass recall is NOT justified.

## §1 — qualified insight lane: rule PASSES on the agg control

Build (PR #258): RETRIEVAL_INSIGHT_EVIDENCE off|routed (default off).
Under routed the fact legs EXCLUDE insight rows (aggregates by
source.recorder, summary_* by predicate prefix — both writers' own
idioms); an insight fusion leg (dense+BM25 through the shared convex
fuse(), world-pinned, PII/user-fenced) feeds a SEPARATE prompt slot —
INSIGHT_TOP_K=4, 800-char/insight budget, never factBudget; dispatch
= summary|enumeration lanes only; the verifier sees the section.

Legs (dist = v8 build):

- **BEAM full-400 vs beam-100k-v6agg** (the mandated post-aggregate
  control): **summarization 12.5% → 22.5%** (+10.0pp, discordant 4-0
  ALL insight, p=0.125); overall 35.7 == 35.7 (15-15). The brief's
  verdict rule (non-negative overall AND summarization strictly up)
  **passes**. Watch: temporal_reasoning 32.5 → 20.0 (0-5, p=0.06) —
  exclusion removes aggregate rows TR consumed in the naive world;
  TR swings 27.5/32.5/20.0 across the three arms (n=40 noise band).
- Triangulation vs PRE-aggregate beam-100k-v6ctl: overall 35.7 vs
  37.8 (−2.0pp, 12-20, p=0.22), summarization +2.5 n.s. — the
  aggregates+insight-lane STACK does not beat the never-composed
  world.
- **MS exclusion arm** (lanes=[] isolates the exclusion):
  52.9 == 52.9, 3-3, p=1.0, tokens flat — exclusion is free on MS.

**Reading**: given aggregate-carrying worlds (MS/BEAM permanently
are), insightEvidence=routed is the correct arbitration — the naive
summarization damage (the V6 null) is recovered and exceeded at zero
overall cost. Composing aggregates in the first place remains
unjustified as a default. Stays default-off; the right per-tenant
setting when aggregates exist.

## §2 — timeline evidence: NULL on the target row + a diagnosis

Build (PR #259): ORDERING_PATTERNS split out of the enumeration
lexicon (+ 'list in order', 'before or after', 'which came first' —
40/40 on the BEAM event_ordering row, 0 new fires on SSA/SSU/TR/MS/
LoCoMo); RETRIEVAL_TIMELINE_EVIDENCE off|routed gives
ordering-shaped questions the chronological segment appendix (the
occurredAt mention record) with a MENTION RECORD header; skipped when
the query resolves to fused.

Leg (BEAM full-400 vs v6agg): **event_ordering 0.0% → 2.5% (1-0 of
40) — null.** Overall +2.5pp (17-7, p=0.064) is NON-CAUSAL: the
appendix fired only on the 40 ordering questions (avg tokens 5921 vs
5032 → ~+8.9k on exactly those), so other rows' swings (preference
+12.5 at 5-0…) are re-roll noise on an unchanged code path — a
useful calibration of BEAM per-row noise (±5-12pp at n=40 between
identical-config runs).

Two follow-ups:

1. **The appendix segment lane is unbudgeted** — the 1200-char
   budget lives only in the fused leg; the appendix ships whole
   windows. Do NOT silently "fix": the E16 78.7 record recipe
   (diary profile, verbatim=always) was measured WITH full windows —
   budgeting it needs its own leg.
2. **Diagnosis**: order preservation is not the event_ordering
   bottleneck — COVERAGE is. Golds demand a curated K-item sequence
   of aspects across ALL sessions; top-5 similarity windows
   structurally cannot enumerate it. V9 candidate: a
   mention-enumeration retrieval (scan the episodic record per
   topic), feeding the existing ordering dispatch skeleton.

## §4/§4.5 — salience scoring: built; write side fails its own gates

Design note: docs/roadmap/importance-scoring-design-2026-08.md.
Build (PR #262): DERIVER_SALIENCE_STAMP (0-3 grade in the same
deriver call; stamped as source.salience — FLEXIBLE, rides
fn::resolve_fact verbatim, zero migrations; golden addition,
owner-review) + RETRIEVAL_SALIENCE_SCORING (scoreRows fold, weights
[0.8, 1.0, 1.1, 1.25], neutral grade exactly 1.0).

Leg SAL-A (wd-sal1 world on the w8cp episodes — differs from wd-v2
only in the stamp section):

1. **Distribution gate FAIL**: mass 0/1/2/3 = 0.4/36/52/11.7% vs the
   rubric's ~10/60/25/5 — systematic grade inflation; the prior would
   boost 64% of rows and stop discriminating.
2. **Write-parity gate FAIL**: the salience section primes over-
   emission — propositions +54…+74% per conversation vs wd-v2
   (483/477/754/683 vs 314/303/434/393). NOT recall-neutral; any
   cross-world QA pair confounds volume with scoring.
3. **Live bug (open)**: one conversation's derive failed with
   SurrealDB "Cannot execute UPDATE statement using value: NONE"
   (world degraded 4/5). Synthetic repro of all three resolver paths
   (insert / in-batch dup / cross-origin corroboration) passes; the
   single-conversation re-derive succeeded with unresolvedSubjects
   2→0 — best current suspect is the unresolved-subject fallback
   path (two subjects collapsing onto one entity). Data-dependent,
   not yet reproduced.

The same-world read A/B (scoring off vs on — the one clean pair) was
attempted and **quota-poisoned**: OpenAI credits ran out at 14:43
mid-arm (sal1off 464/999 empty predictions, sal1on 999/999). Both
reports quarantined as *.quotadeath; rerun-salience-qa.sh in the job
tmp re-runs both arms off the intact wd-sal1 world once credits are
topped up.

**Verdict so far**: the write side as-built fails the design note's
own gates — needs a volume-neutral prompt (grade WITHOUT changing
extraction; e.g. a separate cheap grading turn over the emitted
list) and weights refit to real mass. PR #262 stays the default-off
skeleton.

## §5 — small engineering

- operator_action ts→Date on 3.x + unit: PR #256, merged.
- Dependabot: PR #255 merged — all 35 alerts (root + brain-landing),
  none deferred; PR #263 merged same-day for 3 fresh js-yaml highs.
  Open alerts: 0.
- Eval-stand idioms (THROTTLE_DISABLED=1 et al.):
  docs/operations.md "Eval stand" section.

## Scoreboard

| Leg | Verdict |
|---|---|
| §3a completion-pass confirm | NULL (76.1 vs 77.0, p=0.67) |
| §3b routed SSA (v7 arm) | null by mechanism → 2 live defects fixed (#257) |
| §3b SSA re-run (v8lex) | mechanism confirmed; +3.6pp n.s. at n=56 |
| §1 BEAM insight vs v6agg | RULE PASSES: summ +10.0pp (4-0), overall flat |
| §1 BEAM insight vs v6ctl | stack −2.0pp n.s. — composing aggs still unjustified |
| §1 MS exclusion | wash (3-3) — exclusion free |
| §2 BEAM timeline | NULL on event_ordering (1-0); coverage diagnosis |
| §4.5 salience write | FAILS distribution + parity gates; live bug caught |
| §4.5 salience read A/B | quota-poisoned; rerun prepared |

Session engineering yield beyond the numbers: 3 live defects found
and fixed by legs (routed unreachable, lexicon genre miss,
operator_action datetime), 1 open data-dependent resolver bug, the
BEAM per-row noise calibration, and the event_ordering coverage
diagnosis that reshapes the V9 attempt.
