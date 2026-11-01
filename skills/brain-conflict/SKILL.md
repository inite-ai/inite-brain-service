---
name: brain-conflict
description: How to detect and resolve conflicting beliefs in the INITE Brain knowledge graph — the COMPETING fact status, get_competing_facts, detect_contradiction preflight, and the human-in-the-loop adjudication workflow. Use when the timeline shows two facts disagreeing on the same predicate, or when an agent needs to decide what to record without making the disagreement worse.
---

# brain-conflict

Brain settles every `record_fact` in two steps, and neither one uses a score. At write time it applies only rules that need no judgement: the same value restated **corroborates**, a strictly later `validFrom` **supersedes** the earlier value of the slot, and a strictly earlier one is filed as **history**. Two different values of one slot at the same valid time are both kept, and **fact resolution** (a judge that names the relation) decides what they are. When the judge says the two cannot both be true, both stay alive in COMPETING status. This skill is how you handle those.

## What COMPETING means

`status='competing'` marks a real disagreement: the same attribute of the same subject, at the same time, with two values that cannot both be true and nothing saying one replaced the other. It comes from fact resolution, not from a threshold:

- At write time a value that holds from the same moment as another value of the slot is inserted `active` with `reason: 'for_resolution'`.
- Fact resolution compares the new fact with similar facts on the entity and names each relation: `same` (a paraphrase: corroborates), `replaces` (successive values: valid time decides which closes), `contradicts` (both go `competing`), `unrelated` (nothing changes).
- `single_active` predicates close every overlapping value at write time, so they never reach the judge by overlap.
- `bitemporal_event` predicates decide by calendar day at write time, as before.
- A fact from a system of record (`source.kind = 'source_record'`, a CRM door) never has its status changed by resolution. A claim that disputes it is marked `competing` beside it; the record keeps its slot.

There are no weights, no supersede margin and no reject floor: confidence and source trust are recorded on the fact (`trustSnapshot`) as provenance, never as a vote. Both competing rows stay searchable and are surfaced as a known disagreement. The dreams resolver pass (`/v1/dreams/run`) later asks an LLM judge to break 2-fact pairs older than the min-age gate; 3+ groups stay for human adjudication.

## Detecting disagreements — get_competing_facts

```ts
get_competing_facts({
  entityId: "knowledge_entity:01HXYZ...",
  predicate: undefined,        // optional — filter to one predicate
  asOf: undefined,             // optional — what was competing at this moment
})
```

Returns groups keyed by `(entityId, predicate)`:

```json
{
  "entityId": "knowledge_entity:01HXYZ...",
  "groups": [
    {
      "key": "knowledge_entity:01HXYZ...::status",
      "predicate": "status",
      "facts": [
        { "factId": "...", "object": "active",  "recordedAt": "...", "source": ... },
        { "factId": "...", "object": "churned", "recordedAt": "...", "source": ... }
      ]
    }
  ]
}
```

- A group of **2 facts** is a pair the resolver left for adjudication — the dreams loop will try to break it, or a human will.
- A group of **3+ facts** is a multi-way disagreement the resolver escalated. Dreams resolver won't touch these; they wait for an operator.

`asOf` filters to what was competing at that moment — useful for postmortems ("what was this customer's status disagreement on April 1?").

## Preflight before recording — detect_contradiction

Before you `record_fact` on a contentious predicate, ask brain what would happen:

```ts
detect_contradiction({
  entityRef:    { vertical: "rent", id: "cust_42" },
  predicate:    "status",
  object:       "active",
  validFrom:    "2026-05-01T00:00:00Z",
  confidence:   0.9,
  sourceVertical: "rent",
})
```

Returns:

```json
{
  "wouldOutcome": "INSERTED",
  "reasoning": "Another value of this slot holds from the same moment; the fact would be inserted and fact resolution would judge the pair (a paraphrase corroborates, a replacement supersedes, a disagreement competes).",
  "opposingFacts": [
    { "factId": "...", "object": "churned", ... }
  ],
  "predicatePolicy": { "semantics": "bitemporal", "decayHalfLifeDays": 60, "piiClass": "none" }
}
```

The reasoning string names the valid-time rule that fired (`CORROBORATED`, `SUPERSEDED`, `INSERTED_HISTORICAL`, or `INSERTED` for resolution) and `opposingFacts` lists the values it would meet. Read it before deciding what to do.

## Adjudication workflows

### LLM auto-resolution (dreams loop)

For low-stakes pairs aged past the min-age window, the dreams loop's resolver does this:

1. Pulls competing pairs (`status='competing'` AND age ≥ `DREAMS_RESOLVE_MIN_AGE_DAYS`)
2. Walks neighbouring context facts on the entity
3. Asks an LLM judge to pick `a_wins | b_wins | unsure`
4. On confident verdict, marks the loser superseded; on `unsure`, leaves the pair

This is fully automated and writes through `retract_fact` with `reason: "dreams_resolver:a_wins"` style. The audit row stays — operators can always see "this was resolved by automated judgement".

### Human-in-the-loop (your job as the agent)

For high-stakes pairs or 3+ multi-way groups:

1. `get_competing_facts` to find the disagreement.
2. Present the user the COMPETING pair with timestamps + sources. Phrase it neutrally — "brain has two records for this; which do you want to keep?"
3. On user verdict:
   - Loser → `retract_fact({ factId: <loser>, reason: "operator verdict: <text>" })`
   - Winner stays as-is. The retract revives the supersede chain if needed.
4. Optional: record a fresh fact with the user's verdict and a later `validFrom`. Valid time, not source weight, is what closes the old value at write time.

### Recording a new fact that touches the disagreement

When the user wants to record something new on a predicate that's already in COMPETING, run `detect_contradiction` first. If the dry-run says the new fact would be inserted for resolution beside the disputed values, surface that to the user before you write — "this would create a 3-way disagreement; would you rather pick one of the existing values first?"

## What NOT to do

- **Don't auto-pick by recording time.** Valid time already decided everything it can: a pair left `competing` holds from the same moment. A later `recordedAt` doesn't make one side right, and your agent shouldn't override silently.
- **Don't forget to surface the source.** A competing pair where one source is `human_declared` and the other is `inbox_extraction` is almost always resolvable by the user; the disagreement is between a person and an LLM. Surface that.
- **Don't retract one side of a 3-way without picking the winner.** Retracting one of three competing facts leaves a 2-way pair the resolver still can't break. Either retract two (leaving a single active) or convert the survivors to a single `human_declared` fact via record_fact.
- **Don't ignore `asOf` when adjudicating historical conflicts.** Two facts that competed on April 1 may have been resolved by May — call `get_competing_facts({ asOf: "2026-04-01..." })` to see the historical state, not the current one.

## Pitfalls

- **`single_active` predicates never produce COMPETING by overlap alone.** They close overlapping values at write time. COMPETING on a `single_active` predicate means the judge found a contradiction between values that start at the same moment — check `predicatePolicy` from `detect_contradiction` to confirm the semantics.
- **A record's value is not retracted to settle a dispute.** Record-door facts follow their source system: change the record there, and the next sync supersedes the value. Retract the disputing claim instead.
- **The 2-fact min and 3+ max are by-design.** Dreams resolver only touches 2-fact pairs; the 3+ escalation is the safety valve when the conflict is too tangled for an LLM judge to break confidently.
- **A retract doesn't always revive the supersedee.** Revive only happens for facts retracted via the `supersedeChain` (`retractionReason === 'superseded'`). An explicit operator retract is treated as independent; the predecessor stays superseded.

## Companion tools

- `record_fact` / `retract_fact` — the write side of adjudication (see `brain-write`)
- `detect_contradiction` — preflight before write. It mirrors the write-time valid-time rules exactly; it cannot predict what fact resolution's judge will say about a same-moment pair
- `get_source_reputation` — the learned trust profile of each side's source vertical; context for the human deciding, not something the resolver weighs
- `get_fact` / `get_fact_provenance` — audit one competing fact's trust record (incl. `groundingStatus`) and the verbatim turns behind it before retracting (`FACTS_API_ENABLED` servers)
- `get_entity_timeline` — full history including superseded chain (see `brain-recall`)
- `search_knowledge` — its answer already includes competing values, marked `[competing]`, so a dispute is never hidden behind one side (see `brain-search`)
