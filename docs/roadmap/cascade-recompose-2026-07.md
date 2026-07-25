# Cascade recompose — design & staging

Status: **design landed; Phase 1 built** (migration `0072_derived_staleness` +
`RecomposeService`). Phases 2-3 are still design only. The doc was written
before any code, in the same discipline the LIVE-queries doc applied: write down
what actually exists, name the holes with file:line, and decide the architecture
before touching a hot ingest path.

The short version: **the brain has no cascade recompose.** It has cascade
*delete* for one relation, on one trigger, and coarse nightly full rebuilds for
everything else. Derived state goes stale silently on the most common write path
there is.

## What exists today

**One derivation edge.** `knowledge_fact.derivedFrom`
(`array<record<knowledge_fact>>`, `src/db/schema.surql:63`). Exactly two
producers write it:
- compaction summaries — `compaction-runner.service.ts:207`
- promotion rollups — `promotion-runner.service.ts:241`

**One cascade.** `fn::cascade_retract` (migration `0069`) walks the reverse-
`derivedFrom` closure level by level, one set-based `UPDATE` per level, recursing
on the ids it just retracted (the frontier is an argument, avoiding the SurrealQL
cross-iteration reassignment gotcha). It is a good primitive. It is called from
**exactly one place in the codebase**: `facts.service.ts:259` — the explicit
retract API.

**One change-detector.** `community_build_state` (migration `0061`) stores a
coarse per-tenant signature — live-edge count, newest `createdAt`, and the
`minSize` knob — so the nightly community builder can skip a no-op rebuild.

**One watermark drain.** `changefeed_state` + `SHOW CHANGES FOR TABLE … SINCE …`
(migration `0023`), used by the audit consumer and by the recompose invalidator.
All three knowledge tables carry a 30-day `CHANGEFEED INCLUDE ORIGINAL`.

## The holes

### 1. Supersede does not cascade at all
`fn::resolve_fact` (latest body in `0055_user_scope.surql`) — the path every
routine fact UPDATE goes through — contains no reference to `derivedFrom` and
calls no cascade. So: a fact is superseded, and the summary derived from it keeps
serving the old value. Forever. Silently.

This is the common case, not the edge case. The only path that cascades is a
human calling the retract endpoint.

### 2. Why supersede is invisible to the one cascade there is
`fn::cascade_retract` filters on `retractedAt IS NONE` and writes
`status = 'retracted'`; a supersede writes `status = 'superseded'` and leaves
`retractedAt` alone. So the two do not meet even in principle — the cascade
cannot fire on a supersede no matter who triggers it.

*(Historical note: an LLM consolidation pass built on 2026-07-23 hit this hole
head-on — it collapsed "a renowned outdoor gear company" into "Under Armour" by
superseding the vaguer row, leaving any summary derived from it stale. That pass
was removed the same day after measuring at −0.5pp on LoCoMo dev-5 for 3× the
ingest cost, but the hole it exposed is a property of `fn::resolve_fact`, not of
that pass, and outlived it.)*

### 3. The cascade deletes, it does not recompute
Even on the one trigger that works, a child whose parent was retracted is itself
retracted. `facts.service.ts:235-240` says so outright:

> *"For 0.1.0 we apply a simpler rule: if any parent is retracted, the child is
> retracted. Lazy re-validation on retrieval is a 0.2.0 enhancement."*

That enhancement never landed. A summary over ten facts that loses one parent is
destroyed rather than re-derived over the surviving nine — so the cascade
actively **loses** knowledge that is still true.

### 4. Most derived state records no dependency at all
Nothing can be invalidated when nothing knows what it was computed from:
- **communities** — label propagation over the edge graph; the 0061 signature
  keys on edge COUNT and newest `createdAt`, so a *changed* fact never triggers a
  rebuild, only a new edge does.
- **corroboration count** (`0047`/`0050`/`0051`) — incremented in place.
- **`trustSnapshot`** (`0044`) — deliberately frozen onto the fact at write time.
  Frozen is a valid design; it just means "recompute" is undefined for it and
  that should be explicit, not accidental.
- **canonical predicate grouping** — not built yet, and the measurement says it
  matters: in the benchmark tenant the open profile coins 3644 distinct
  predicates over 6153 facts, and **81.5% of them are used exactly once**, so
  the predicate groups nothing. Whenever it does land, the canonical key is
  derived from the registry's aliases and goes stale when they change — i.e. it
  is born needing this document's machinery.

### 5. The class of dependency that hides in an embedding basis
An embedding built from anything mutable is a derived artifact with an
unrecorded dependency. The sharpest case was `INGEST_FACT_SENTENCE_EMBEDDING`
(embed a sentence containing the subject entity's **name**): `fn::merge_identity`
(`0037`) renames by pointer without rewriting facts, so after a merge every fact
of the merged-away entity carried an embedding keyed on a stale name, with
nothing to notice. That flag was removed on 2026-07-24 (it measured −2.9pp — the
constant subject-name collapsed intra-entity distinguishability, killing
multi-hop), so the specific instance is gone. The general trap is not: any
future "embed X from a mutable field" repeats it, which is why an embedding
basis has to be a registrable dependency kind, not an afterthought.

### 6. There is no "when needed"
Every recompute in the system is a nightly cron over everything, or nothing.
Compaction is age-driven (`COMPACTION_HOT_RETENTION_DAYS`), promotion is
age-driven (`COMPACTION_PROMOTION_AGE_DAYS`), communities are nightly with a
coarse skip. Nothing recomputes because an input changed.

## What cascade recompose has to be

1. **Dependencies recorded for every derived artifact, generically.**
   `derivedFrom` is a fact→fact array; communities, embeddings and canonical keys
   are not facts. The dependency edge has to live outside `knowledge_fact`.
2. **Invalidation on CHANGE, not only on delete.** Supersede is the common path.
3. **Lazy — recompute when needed, not on write.** Eagerly re-running label
   propagation over a 1M-edge graph on every fact write is a thundering herd, and
   the reason to build a dependency graph at all is to avoid exactly that.
4. **Recompute, not retract.** Re-derive from the surviving parents; drop the
   artifact only when its parent set is empty. This is the fix for hole 3, and it
   is the difference between a memory that heals and one that erodes.
5. **Trigger from the changefeed watermark**, not a subscription. Same conclusion
   the LIVE-queries doc reached for a different reason: a watermark cannot miss
   work while a pod is down, because the cursor simply has not moved.

## Design

### `derivation` — the dependency edge, generalized
One row per derived artifact, outside `knowledge_fact`:

| field | meaning |
|---|---|
| `artifact` | record id of the derived thing (fact, community, …) |
| `artifactKind` | `summary` / `promotion` / `community` / `canonical_key` / … |
| `dependsOn` | the inputs it was computed from |
| `inputsHash` | hash of the input set + the knobs that shaped it |
| `computedAt` | when it was last derived |
| `staleAt` | set by invalidation; `NONE` = fresh |

`inputsHash` generalizes the 0061 signature: a change that leaves the input set
identical must not trigger a recompute. Without it, invalidation degenerates into
"recompute everything, nightly" with extra bookkeeping.

### Invalidation — one drain, set-based per level
The changefeed drain maps changed record ids → dependent artifacts → `staleAt`.
The traversal is the same shape `fn::cascade_retract` already proves on 3.x:
one set-based `UPDATE` per level, recursing on the frontier as an argument.
Reuse that idiom rather than inventing a second one.

### Recompute — policy PER ARTIFACT KIND, not one rule
This is the part that must not be uniform:
- **summaries / promotions** — recompute lazily on read, over the surviving
  parents, behind a per-artifact lock so a read storm computes once.
- **communities** — far too expensive for a read path: mark stale and ENQUEUE;
  the existing nightly job drains the stale set instead of rebuilding blindly.
- **fact embeddings after an entity rename** — batch re-embed as a job; a read
  path must never call the embedder.
- **`trustSnapshot`** — explicitly declared NON-recomputable (frozen by design),
  so it is never registered and never marked stale.

Serving a stale artifact while its recompute is enqueued is acceptable for
communities and NOT acceptable for a summary that contradicts a corrected fact —
that difference is per-kind policy, and writing it down is most of the work.

## What NOT to do

- **Do not recompute eagerly on write.** The whole point of the dependency graph
  is to defer.
- **Do not fix hole 1 by cascade-RETRACTING on supersede.** That is the naive
  patch and it would destroy a summary on every routine fact update. Recompute is
  the requirement.
- **Do not use LIVE SELECT as the trigger.** A dropped subscription misses the
  gap; the watermark cannot.
- **Do not overload `knowledge_fact.derivedFrom`** to carry non-fact artifacts.
- **Do not register `trustSnapshot`** as recomputable — frozen-at-write is a
  deliberate property of the trust model, not an oversight.

## ⚠️ The changefeed item shape is a trap (found the hard way, 3.2.1)

Under `CHANGEFEED … INCLUDE ORIGINAL` the `SHOW CHANGES` item layout **differs
by operation**:

```
CREATE → { update: { …full row… } }
UPDATE → { current: { …full row… },
           update: [ {op, path, value}, … ] }   ← a PATCH ARRAY
DELETE → { delete: "<record id>" }
```

So on an UPDATE, `item.update` is a list of diff operations, and
`item.update.id` reads `undefined`. A drain written that way **sees creates
only and silently misses every update** — while still running, advancing its
cursor, and reporting success. Since supersede IS an update, that failure mode
is invisible and total for the exact case this whole document is about.

Two drains here were written that way before a live check caught it (the
recompose invalidator, and a consolidation sweeper since removed). It now goes
through `src/db/changefeed-row.ts`, whose test pins the verbatim 3.2.1 shapes.

The patch ops are also **reversed** — they describe how to get from the current
row back to the original, which is what "include original" means. Do not read
them as forward changes.

**Pre-existing, not fixed here:** `changefeed-drain.service.ts`
(`buildAuditEventBatch`) derives its op as `Object.keys(item)[0]`, which on an
update yields `"current"`. Its `recordId` still resolves correctly, so audit
rows are not lost, but every update is labelled with the wrong op. Out of scope
for this change; worth a follow-up.

## Staging recommendation

1. **Land this doc.**
2. **Phase 1 — close the supersede hole for the dependency that already exists.**
   `derivedFrom` is written and indexed today; make supersede mark derived facts
   stale, and recompute a summary over its surviving parents on read. Smallest
   slice that fixes something actually broken (including hole 2), and it exercises
   the recompute-not-retract rule on the simplest artifact kind.
3. **Phase 2 — the generic `derivation` table + the invalidation drain.** Migrate
   compaction and promotion onto it; `derivedFrom` stays as the audit trail.
4. **Phase 3 — register the dependency-less artifacts**: communities (replacing
   the 0061 signature), the canonical predicate key once it exists, and
   entity-name-derived embeddings.

Phase 1 is worth doing on its own even if 2 and 3 never happen; phases 2-3 are
only worth it once more than one artifact kind is registered.
