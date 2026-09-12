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
resolver documents as *"No conflict possible at ingest"*. So every
predicate the extractor coins is, permanently:

* never superseded — the prior value stays `active` with no `validTo`;
* never `competing` — two sources disagreeing never meet;
* only ever accumulating.

Measured on a live tenant before the fix:

| | count |
|---|---|
| predicates registered by `llm_auto` | **186** |
| …of those, `single_active` | **0** |
| predicates that could supersede at all | 15 (the hand-seeded ones) |
| facts with `validTo` | 0 |
| facts `superseded` | 0 |

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
predicate, per tenant, asking the only question that matters: *when the
subject gets a new value, does the previous value stop being true?*

Conservative by construction. Ambiguity → `append_only`. No API key,
a throw, an unparseable answer, an off-enum value → `append_only`. The
pass can only ever ADD supersession where the judge is confident, because
wrongly calling a multi-valued predicate `single_active` silently retires
facts that should coexist, while the reverse merely leaves a
disagreement standing for the competing-facts surface to show.

Runs once per predicate per tenant (the row is then in the registry) and
never touches aliased, seeded or operator-edited predicates.

## Measured

Same corpus, same stand, same flags (`CONFLICT_*` arm), fresh tenant —
the only difference is the judge.

**Mechanism** (deterministic):

| | before | after |
|---|---|---|
| `llm_auto` predicates classified `single_active` | 0 / 186 | **52 / 147** |
| facts `superseded` at ingest | 0 | 1 |
| facts `competing` | 2 | 6 |
| direct-ingest outcomes | all `INSERTED` | `launch-v2: SUPERSEDED`, `cutoff-docs: COMPETING` |

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
fails at *entity resolution* — the tenant holds **eight** Meridian
entities (`Meridian`, `meridian`, `Meridian API`, `Meridian payouts
API`, `Meridian integration`, `Meridian sandbox`, …), because the
direct-ingest `entityRef` and the extraction-coined name never merge, not
even across case. That is the next defect, and it is upstream of
everything the conflict machinery can do.

**Extraction year drift**, seen in the same trace: `validFrom=2025-03-25`
for a fact whose turn is dated 2026-03-25, and `2025-04-15` for
`pilot_launch_date`. The extractor is reading the date VALUE into the
validity stamp with the wrong year. Separate defect, separate fix.

---

# The wave, four arms

Each arm adds one change to the one before it. Same corpus, same stand,
fresh tenant each time.

| arm | change added | score |
|---|---|---|
| base | `CONFLICT_*` on | 20/32 |
| +judge | predicate cardinality (#592) | 21/32 |
| +ent | entityRef adoption (#593) | 20/32 |
| +scope | per-user read fence on (#594) | 20/32 |

**The score did not move.** One arm reads +1 and the rest read 0, which
at this sample size means nothing at all — see the noise section below.
What DID move is three mechanisms, each with evidence that is not a
score:

| mechanism | evidence |
|---|---|
| predicate cardinality | `llm_auto` `single_active` 0/186 → 52/147; `superseded` 0 → 1; `competing` 2 → 6 |
| entity adoption | the lowercase `meridian` twin is gone; both cutoff values now sit `competing` on ONE `Meridian` |
| read fence | the timeline's WHERE clause widened; `d2-queue` and `d2-launch` flipped to pass with the history in the right order |

The read fence is the only one that also produced score movement, and it
is the one whose mechanism is closest to the check.

## ⚠ The battery is too noisy to read single-check deltas

Across the four arms, **7 of 32 checks flip-flop** with no mechanism
behind the change:

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

* **A single run cannot validate a change on this instrument.** An arm
  needs repeats (3+ runs) before its headline number means anything, or
  the battery needs enough checks that one flip does not move it.
* **Read the mechanism, not the scorecard.** Every real finding in this
  wave came from querying rows and traces — the registry table, the
  fact statuses, the entity list, the WHERE clause — and NONE of them
  would have been visible in the number.
* The dimensions that never move (D3, D4, D8, D10) are the mechanical
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
