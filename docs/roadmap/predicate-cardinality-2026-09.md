# Predicate cardinality: why "what is it NOW" had no answer

2026-09-12. Found by reading decision traces on a live stand, not by
review. Companion to `flag-inventory-2026-09.md` (same wave).

## The defect

`canonicalize()` inserts a newly coined predicate with a comment that
names its own gap:

```ts
// Below threshold — propose. Inherits DEFAULT policy until an
// operator (or a future LLM-classify pass) sets the proper one.
```

The pass was never built, and there is no operator step in a stock
deployment. `DEFAULT_FALLBACK.semantics` is `append_only`, which the
resolver documents as _"No conflict possible at ingest"_. So every
predicate the extractor coins is, permanently:

- never superseded — the prior value stays `active` with no `validTo`;
- never `competing` — two sources disagreeing never meet;
- only ever accumulating.

Measured on a live tenant before the fix:

|                                        | count                     |
| -------------------------------------- | ------------------------- |
| predicates registered by `llm_auto`    | **186**                   |
| …of those, `single_active`             | **0**                     |
| predicates that could supersede at all | 15 (the hand-seeded ones) |
| facts with `validTo`                   | 0                         |
| facts `superseded`                     | 0                         |

Every evolution pair in the corpus sat as `active` + `active`:

```
queue_backend   Redis Streams    active  vf=2026-03-02  vt=None
queue_backend   NATS JetStream   active  vf=2026-03-18  vt=None
payout_cutoff   17:00 UTC        active  vf=2026-03-10  vt=None
payout_cutoff   16:30 UTC        active  vf=2026-03-25  vt=None
```

Asked "what is the CURRENT queue backend", the engine answered
**Redis Streams** — the March 2 value, replaced on March 18 — citing
`code_memory__decided = "the job queue backend for ledger-sync is Redis
Streams"`. Three memory-fitness dimensions (D1 currency, D2 evolution,
D6 conflict surfacing) were failing on this one cause, and no amount of
retrieval work could have moved them: the distinction they ask about was
not written down.

Note what this is NOT: not a retrieval defect, not the four `CONFLICT_*`
levers (measured the same day, +4 checks, and irrelevant here — the
resolver branch for an `append_only` predicate never reaches them).

## The fix

`PredicateSemanticsJudgeService` — one small strict-JSON call per NOVEL
predicate, per tenant, asking the only question that matters: _when the
subject gets a new value, does the previous value stop being true?_

Conservative by construction. Ambiguity → `append_only`. No API key,
a throw, an unparseable answer, an off-enum value → `append_only`. The
pass can only ever ADD supersession where the judge is confident, because
wrongly calling a multi-valued predicate `single_active` silently retires
facts that should coexist, while the reverse merely leaves a
disagreement standing for the competing-facts surface to show.

Runs once per predicate per tenant (the row is then in the registry) and
never touches aliased, seeded or operator-edited predicates.

## ⚠ The first version of this fix was inert — and the doc said otherwise

Writing `semantics` onto the registry row changed nothing, because
nothing read it. `canonicalize()` inserts a novel predicate with
`status: 'proposed'`, and `policyFor()` read `snapshot.byId`, which is
built from `status === 'active'` rows ONLY. Measured on a live tenant:
**143 of 143 `llm_auto` rows were 'proposed'** — the entire coined
vocabulary — so every one of those facts kept resolving on
`DEFAULT_FALLBACK`'s `append_only`.

Which means the table below, in its first form, was reporting a WRITE
and calling it a fix. The `SUPERSEDED` / `COMPETING` outcomes in that run
came from `CONFLICT_DIRECT_FACT_SLOT`, which promotes on the
`__default__` fallback — not from the classification.

Three things had to land before any of it was real:

1. **`policyById` = active ∪ proposed**, and `policyFor` reads it. A
   proposed row's policy is now reachable; an active row of the same id
   still wins.
2. **Register on first sight.** Only the EXTRACTION path called
   `canonicalize()`, so a predicate arriving solely through
   `POST /v1/ingest/fact` was never coined or classified at all — and in
   a mixed corpus, whichever path touched a predicate first decided
   whether the other path's facts could ever supersede.
3. **Let an auto-proposed slot compete.** Once classification reached the
   resolver, the payout-cutoff pair went `COMPETING` → `SUPERSEDED`: a
   `single_active` slot supersedes UNCONDITIONALLY, so the margin
   doctrine — and `CONFLICT_TEMPORAL_TIEBREAKER`, which only arms for
   `bitemporal` — never ran. The direct-path promotion now covers
   `single_active` **on proposed rows only**: a seeded `address`/`status`
   keeps unconditional supersede (a typed re-write IS the new truth); a
   guess about a coined predicate earns the margin doctrine, because two
   standing sources are the common case there.

The lesson is the one this whole wave keeps teaching: **verifying the
write is not verifying the behaviour.** Read the value back through the
code that consumes it.

## Measured

Same corpus, same stand, same flags (`CONFLICT_*` arm), fresh tenant —
the only difference is the judge.

**Mechanism** (deterministic):

|                                                  | before         | after                                             |
| ------------------------------------------------ | -------------- | ------------------------------------------------- |
| `llm_auto` predicates classified `single_active` | 0 / 186        | **52 / 147**                                      |
| facts `superseded` at ingest                     | 0              | 1                                                 |
| facts `competing`                                | 2              | 6                                                 |
| direct-ingest outcomes                           | all `INSERTED` | `launch-v2: SUPERSEDED`, `cutoff-docs: COMPETING` |

Classification reads correctly by eye. `single_active`: `payout_cutoff`,
`pilot_launch_date`, `retry_policy`, `job_queue_backend`, `deployed_to`,
`payout_batch_size`, `listens_on_port`, `log_retention_period`.
`append_only`: `calls`, `contains`, `caused`, `emits`, `owns`,
`informed_about`, `identified_bug`, `reconciles`.

Visible false-positive class: **relation-shaped predicates** whose object
is another entity — `replaces`, `superseded_by`, `alternative_to` — where
a second edge would wrongly retire the first. None of them collided in
this corpus; worth a follow-up guard (skip the judge when the object
resolves to an entity).

**Score**: 20/32 → **21/32**. Three gains (`d1-queue` — the target
dimension — plus `d5-warehouse`, `d5-mobile`), two losses (`d1-retry`,
`d7-port`). Both losses were checked against the data: the facts they
depend on are untouched (no `validTo`, no `superseded`, `8443` still
active), so they are answer-side variance, not damage. Net +1 is inside
run-to-run noise; the mechanism change is not.

## What this did NOT fix, and why

**The ingest-ordering race.** The policy that applies is the one in the
registry AT INGEST TIME, and a predicate is coined by the extraction path.
A fact written before its own predicate is classified takes
`append_only`. Three `(entity, predicate)` groups still hold multiple
distinct active values for exactly this reason, `retry_policy` among
them. A backfill/reclassify pass over existing `llm_auto` rows — plus a
re-resolve of their facts — is the follow-up.

**D6 is still 0/2, but for a new reason.** The conflict is now recorded:
both payout-cutoff values sit `competing` on entity `meridian`. The check
fails at _entity resolution_ — the tenant holds **eight** Meridian
entities (`Meridian`, `meridian`, `Meridian API`, `Meridian payouts
API`, `Meridian integration`, `Meridian sandbox`, …), because the
direct-ingest `entityRef` and the extraction-coined name never merge, not
even across case. That is the next defect, and it is upstream of
everything the conflict machinery can do.

**Extraction year drift — FIXED** (was the cause of the only stable
regression above). Two defects in `parseWith`, and the first version of
this section stopped one step short of both by concluding "something
after `factValidFrom` rewrites it". It did not: the rewrite is inside
the parse, and `INGEST_EVENT_TIME_EXTRACTION` was ON — I had checked an
env FILE instead of asking the running service, which is the same
short-chain error this page keeps recording.

The repro:

```
turn d6a-c2-t03, emittedAt 2026-03-10T10:10:00Z
  "Root cause found (2026-03-10): the retry handler re-enqueued …"

  clarified_duplicate_payout   validFrom 2026-03-10T10:10:00Z   ✓
  identified_root_cause        validFrom 2025-03-10T00:00:00Z   ✗
```

Two facts, ONE turn, one `emittedAt` — and one of them lands at midnight
a year early. `INGEST_EVENT_TIME_EXTRACTION` is OFF on this stand, so
`factValidFrom` returned `emittedAt` for both; something after it
rewrites one. Midnight + year−1 is the signature of a past-biased date
parse against a same-day reference ("March 10" is not strictly before
2026-03-10, so it walks back a year). The answer it produces is
"identified on 2025-03-10", which is why the temporal check fails.

Two causes, one function:

1. **A stated year is an assertion.** The year rollback exists for a bare
   "12 September", where chrono picks a nearest occurrence that can land
   forward. Applied to `2026-03-10` it invents a year the text never
   contained — and chrono resolves a date-only expression to MIDDAY, so a
   date on the SAME DAY as its message already compared as future.
2. **A time of day is not an event date.** "the payout cutoff is 16:30
   UTC" contains no date; chrono answers with the time from the text and
   the calendar day borrowed from the reference. That accounted for the
   last 4 drifted facts, and compounded — 16:30 is later than a 14:35
   message, so it read as future and took the rollback too.

Component certainty is the exact discriminator, and this was verified
against chrono directly instead of assumed:

```
"16:30 UTC"        hour                 <- no date
"2026-03-10"       year, month, day
"yesterday"        year, month, day
"three weeks ago"  year, month, day
"December 20"      month, day
"last Friday"      weekday              <- a date, relatively
"last month"       year, month
```

`weekday` earns its place in the accepted set: leaving it out silently
retired the weekday cases the module was built for — caught by the
existing specs, not by the battery.

Facts stamped before 2026 on a fresh tenant: **11 → 0**. D4 temporal
anchors: 4/4 in three consecutive runs.

---

# The wave, four arms

Each arm adds one change to the one before it. Same corpus, same stand,
fresh tenant each time.

| arm    | change added                  | score |
| ------ | ----------------------------- | ----- |
| base   | `CONFLICT_*` on               | 20/32 |
| +judge | predicate cardinality (#592)  | 21/32 |
| +ent   | entityRef adoption (#593)     | 20/32 |
| +scope | per-user read fence on (#594) | 20/32 |

**The score did not move.** One arm reads +1 and the rest read 0, which
at this sample size means nothing at all — see the noise section below.
What DID move is three mechanisms, each with evidence that is not a
score:

| mechanism             | evidence                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| predicate cardinality | `llm_auto` `single_active` 0/186 → 52/147; `superseded` 0 → 1; `competing` 2 → 6                                    |
| entity adoption       | the lowercase `meridian` twin is gone; both cutoff values now sit `competing` on ONE `Meridian`                     |
| read fence            | the timeline's WHERE clause widened; `d2-queue` and `d2-launch` flipped to pass with the history in the right order |

The read fence is the only one that also produced score movement, and it
is the one whose mechanism is closest to the check.

## ⚠ The bigger question: this whole page is about the FACT plane

Everything above repairs `knowledge_fact` conflict semantics — predicate
cardinality, supersede, the cosine floor on the bitemporal pool — to
reconstruct "what is the value NOW". The architecture moved away from
that. The belief plane (0120) already states it outright, and on the same
tenant that FAILED `d1-queue` on the fact path:

```
ledger-sync — deployment target: AWS ECS Fargate (was: Fly.io)
ledger-sync — pilot launch date: 2026-05-06  (was: 2026-04-15)
ledger-sync — retry policy: exponential backoff capped at 5 attempts
                            (was: 3 retries with a 30s delay)
ledger-sync — queue backend: NATS JetStream  (was: Redis Streams)
ledger-sync — payout batch size: 200         (was: 500)
```

Value AND prior value, one row per slot, for every D1/D2 question plus
`d7-port` and `d9`. `d2-beliefs` is the one D2 check that passes stably
across the whole wave — because it is the only one that reads this table.

And both ends are off:

|                           | default                                                |
| ------------------------- | ------------------------------------------------------ |
| `BELIEFS_API_ENABLED`     | 1 — readable                                           |
| `BELIEFS_SERVING_LANE`    | **0** — the answer path never consults it              |
| `BELIEFS_FACT_DAMPING`    | **0**                                                  |
| `SCENES_BELIEF_PROMOTION` | **0** — on a stock install the rows are never produced |

The lane's own docblock: _"REPEALS the 0120 shadow doctrine ('nothing on
the serving path reads this table') behind the default-off master flag."_

### Measured, not assumed

Turning the lane on (+ damping), three runs, same corpus:

| arm                   | stable pass | stable fail | unstable | scores       |
| --------------------- | ----------- | ----------- | -------- | ------------ |
| repaired fact plane   | **21**      | 3           | **8**    | 25 / 24 / 27 |
| + belief serving lane | 19          | 3           | 10       | 24 / 23 / 23 |

**The lane as built is worse.** Two stable gains (`d5-warehouse`,
`d6-competing-api`) against `d1-deploy` and `d6-answer` going stably
fail and four checks falling out of stable-pass.

The data is right and the rendered statements are right — verified row by
row. What is wrong is how the lane COMPETES: it appends top-3 belief
lines beside the full fact evidence, and the damping does not displace
the stale fact lines those beliefs supersede. So the prompt carries both
the belief and the fact it was promoted from, and the generator picks.

That is the real shape of "we moved away from facts": the substrate did,
the serving path did not, and the one lane that bridges them was built to
ADD evidence rather than to REPLACE it. Fixing the fact plane — this
whole page — was treating the symptom of that.

## Where the instability actually lives

The earlier rounds of this page called the battery noisy and moved on.
That was the short chain again: "noisy" is a symptom, not a cause. Taking
one unstable check (`d1-queue`) and asking WHY, on a finished tenant:

```
/v1/search    x6  -> 10 hits, 39 facts, identical signature 6/6
/v1/synthesize x8 -> identical answer, identical citation 8/8
```

**Neither retrieval nor synthesis varies.** The read path is
deterministic. So the variance is in what gets WRITTEN — and comparing
the three runs' stored worlds found it twice over.

### 1. A TTL race in the registry cache

`canonicalize()` patches the cached snapshot after an auto-insert so a
repeat coinage short-circuits instead of re-embedding — but it patched
`aliasMap` and `knownIds` ONLY. The row it had just written stayed
invisible to `policyFor` until the snapshot TTL expired. So whether a
coined predicate's semantics was in effect for the NEXT write of the
same slot depended on whether a reload happened in between:

| predicate       | first coined                    | result across 3 runs        |
| --------------- | ------------------------------- | --------------------------- |
| `retry_policy`  | turn ingest (reload intervened) | superseded correctly        |
| `queue_backend` | a direct write                  | **both values active, 3/3** |

Same corpus, same code, different stored worlds.

### 2. The promotion without its floor

Closing the race was not enough — `queue-v2: INSERTED` persisted with the
policy correctly `single_active`. The direct-path promotion had copied
the mention path's promotion without its load-bearing half: the
`bitemporal` pool still gates on cosine ≥ 0.85, and two values of one
slot are **contradictory, not similar** — "Redis Streams" vs "NATS
JetStream" is nowhere near it — so the pool emptied and both landed
plainly active.

A declared single-value slot needs no cosine to establish claim identity;
`fn::resolve_fact` already matches entity, predicate, user and world. The
promotion now carries `SLOT_EXACT_SIMILARITY_FLOOR`, as the mention path
always has. `__default__` keeps the gate — open-vocabulary slots are
where cosine IS the signal.

After both: `queue-v2`, `retry-v2`, `launch-v2`, `deploy-v2` **all
SUPERSEDED** and `cutoff-docs` **COMPETING**, in 3/3 runs.

### What is left, and it is not "noise" either

`d1-queue` still flips — and the slot is now identical in all three
tenants (Redis superseded, NATS active). The difference is elsewhere:

```
run 0  pass   ... job_queue_backend = Redis Streams   (present)
run 1  fail   "abstained on a known value"            (ABSENT)
run 2  pass   ... job_queue_backend = Redis Streams   (present)
```

**Extraction coins different predicates on different runs**, the evidence
set changes with it, and the abstention gate flips. That is the residual
variance, located rather than named — and it is the same defect as the
engine citing a `code_memory__decided` sentence over a typed slot:
extraction emits redundant parallel representations of one fact, and
non-deterministically.

## Stage by stage

| stage               | stable pass | stable fail | unstable  | scores           |
| ------------------- | ----------- | ----------- | --------- | ---------------- |
| base                | 20          | 12          | — (1 run) | 20               |
| + cardinality chain | 16          | 5           | 11        | 21 / 20 / 22     |
| + year-drift fix    | 18          | 5           | 9         | 22 / 23 / 24     |
| + race and floor    | **21**      | **3**       | **8**     | **25 / 24 / 27** |

Two checks are stable gains against base across all three runs
(`d2-queue`, `d2-retry`); nothing regressed stably.

## The measurement that finally means something

Three runs of the finished pipeline, fresh tenant each, against the base
arm's single 20/32:

|                           | stable pass | stable fail | unstable | scores           |
| ------------------------- | ----------- | ----------- | -------- | ---------------- |
| before the year-drift fix | 16          | 5           | **11**   | 21 / 20 / 22     |
| after                     | **18**      | 5           | **9**    | **22 / 23 / 24** |

Two checks moved fail → pass in **all three** runs, each with a mechanism
behind it, and **nothing regressed stably**:

- `d2-queue` — evolution history, from the read fence (#594)
- `d6-competing-api` — conflict surfacing, from the cardinality chain

`d4-rootcause-date`, the one stable regression of the earlier round, is
now a stable pass: it was the year drift, exposed rather than caused.

Note what moved the needle: not the score-chasing, but tracing ONE fact
from its turn to its stored row and following each branch to a root.
Every earlier round of this wave stopped at the first plausible cause and
shipped a patch that measured as noise.

## The run that finally had all three pieces

Three runs, same build, fresh tenant each:

| run | score |
| --- | ----- |
| 1   | 21/32 |
| 2   | 20/32 |
| 3   | 22/32 |

Deterministic in **3/3**: `retry-v2: SUPERSEDED` (INSERTED in every
earlier arm), `cutoff-docs: COMPETING`, `launch-v2: SUPERSEDED`.

**D6 scored for the first time in the wave** — 1/2 in each of the three
runs, having been 0/2 in all four earlier arms. Which of its two checks
passes flips between runs (the entity-ranking noise below), but the
write side that makes either possible is now deterministic.

The headline score — 20/21/22 against a base of 20 — says nothing. See
below.

## ⚠ The battery is too noisy to read single-check deltas

Three runs of the SAME build, same corpus, same config, fresh tenant
each: **11 of 32 checks are unstable** — 16 stable pass, 5 stable fail,
11 that disagree with themselves.

```
d1-launch          pass fail fail      d5-warehouse       fail pass pass
d1-queue           pass fail pass      d6-answer          fail pass fail
d1-retry           pass fail fail      d6-competing-api   pass fail pass
d2-launch          fail fail pass      d7-port            fail fail pass
d5-mobile          fail pass fail      d8-enqueue-idiom   pass fail fail
d9-batch-size      pass pass fail
```

Only TWO checks changed stably against the base across all three runs:
`d2-queue` (gain) and `d4-rootcause-date` (loss — see the year drift
below, which this exposed rather than caused).

So the noise floor is **±5, not ±3**, and every headline number in this
document — including the +1 the first version of this page reported as a
result — sits inside it. The earlier four-arm table is kept below as the
record of what was measured, not as evidence of anything.

Across those four arms the same instability shows as **7 of 32**
flip-flopping with no mechanism behind the change:

```
d1-queue           fail pass fail fail
d1-retry           pass fail pass pass
d5-mobile          fail pass fail fail
d8-enqueue-idiom   fail fail pass fail
d4-rootcause-date  pass pass fail fail
d9-batch-size      pass pass pass fail
d7-port            pass fail fail fail
```

That is **~22% of the battery unstable run-to-run**, which puts the
noise floor at roughly ±3 checks — larger than any effect measured in
this wave. Every "+1" and "−1" above is inside it.

Consequences, and they are not optional:

- **A single run cannot validate a change on this instrument.** An arm
  needs repeats (3+ runs) before its headline number means anything, or
  the battery needs enough checks that one flip does not move it.
- **Read the mechanism, not the scorecard.** Every real finding in this
  wave came from querying rows and traces — the registry table, the
  fact statuses, the entity list, the WHERE clause — and NONE of them
  would have been visible in the number.
- The dimensions that never move (D3, D4, D8, D10) are the mechanical
  ones; the ones that flip are the ones whose verdict goes through a
  generator. That is where the variance lives.

## D6 is now a single, identified defect

No longer "impossible by construction". The conflict is recorded and
visible: both `payout_cutoff` values sit `competing` on `Meridian`, and
the read fence can see them. The check still fails because the eval
resolves the entity by searching, and:

```
0 Priya    | payout_cutoff: False
1 Argus    | payout_cutoff: True     ← picked
2 Meridian | payout_cutoff: True     ← where the competing pair is
```

`Argus` carries `payout_cutoff = 16:30` because extraction attached the
relayed statement to **the person who reported it** rather than to the
thing it is about. Same for `Priya`, who holds
`informed_about = "the Meridian payout cutoff is 17:00 UTC"`.

**Subject attribution is the next defect**: a relayed statement's
subject should be what the statement is about, with the reporter kept as
provenance. It is an extraction-prompt change (fresh `derivedVersion`,
whole-corpus blast radius), so it wants its own pass — and, given the
noise floor above, its own repeated measurement.
