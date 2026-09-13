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
