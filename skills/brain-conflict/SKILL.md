---
name: brain-conflict
description: How to detect and resolve conflicting beliefs in the INITE Brain knowledge graph — the COMPETING fact status, get_competing_facts, detect_contradiction preflight, and the human-in-the-loop adjudication workflow. Use when the timeline shows two facts disagreeing on the same predicate, or when an agent needs to decide what to record without making the disagreement worse.
---

# brain-conflict

Brain's conflict resolver runs on every `record_fact`. Most of the time it picks a winner cleanly — the new fact either INSERTED (no overlap), SUPERSEDED (clearly beats the prior), or REJECTED (too unconfident). When it can't pick — when two facts overlap in valid-time, are too semantically close, and score within margin — they BOTH stay alive in COMPETING status. This skill is how you handle those.

## What COMPETING means

The conflict resolver writes `status='competing'` when:

- The predicate is `bitemporal` (`status`, `intent`, `address`, …) — `single_active` predicates always supersede.
- A prior fact's valid-time interval overlaps the new fact's.
- The two facts are cosine-similar above `CONFLICT_SIMILARITY_THRESHOLD` (semantically close enough that one might be a rephrase of the other).
- The score gap between them is ≤ `CONFLICT_MARGIN_SUPERSEDE` — neither dominates.

The resolver refuses to pick. Both rows stay searchable but are surfaced as a known disagreement. The dreams loop's resolver pass (`/v1/dreams/run`) periodically wakes up and asks an LLM judge to break ties for pairs older than the min-age gate; multi-way conflicts (3+) escape auto-resolution and stay for human adjudication.

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
  "wouldOutcome": "COMPETING",
  "reasoning": "bitemporal predicate, strongest similar prior (cosine 0.91) score 0.612 too close to candidate 0.624 (gap 0.012) within margin; both would remain active in COMPETING status.",
  "opposingFacts": [
    { "factId": "...", "object": "churned", ... }
  ],
  "predicatePolicy": { "semantics": "bitemporal", "decayHalfLifeDays": 60, "piiClass": "none" }
}
```

The reasoning string names the rule that fired and the numerical gap. Read it before deciding what to do.

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
4. Optional: record a fresh fact reinforcing the user's verdict with `human_declared` source — that source class has the highest trust weight and tilts future conflicts the same way.

### Recording a new fact that touches the disagreement

When the user wants to record something new on a predicate that's already in COMPETING, run `detect_contradiction` first. If the dry-run says the new fact would also land COMPETING, surface that to the user before you write — "this would create a 3-way disagreement; would you rather pick one of the existing values first?"

## What NOT to do

- **Don't auto-pick by recency.** "Newer = right" is the resolver's *recency* weight, not a UI rule. If the resolver decided not to pick, your agent shouldn't override silently.
- **Don't forget to surface the source.** A competing pair where one source is `human_declared` and the other is `inbox_extraction` is almost always resolvable by the user; the disagreement is between a person and an LLM. Surface that.
- **Don't retract one side of a 3-way without picking the winner.** Retracting one of three competing facts leaves a 2-way pair the resolver still can't break. Either retract two (leaving a single active) or convert the survivors to a single `human_declared` fact via record_fact.
- **Don't ignore `asOf` when adjudicating historical conflicts.** Two facts that competed on April 1 may have been resolved by May — call `get_competing_facts({ asOf: "2026-04-01..." })` to see the historical state, not the current one.

## Pitfalls

- **`single_active` predicates never produce COMPETING by overlap alone.** They auto-supersede. If you see COMPETING on a `single_active` predicate, the resolver is in an unusual state — check `predicatePolicy` from `detect_contradiction` to confirm.
- **The 2-fact min and 3+ max are by-design.** Dreams resolver only touches 2-fact pairs; the 3+ escalation is the safety valve when the conflict is too tangled for an LLM judge to break confidently.
- **A retract doesn't always revive the supersedee.** Revive only happens for facts retracted via the `supersedeChain` (`retractionReason === 'superseded'`). An explicit operator retract is treated as independent; the predecessor stays superseded.

## Companion tools

- `record_fact` / `retract_fact` — the write side of adjudication (see `brain-write`)
- `detect_contradiction` — preflight before write. Fidelity note: the dry-run scores with the SEED source-trust table and authority 0; the live resolver uses learned domain-scoped rates + declared authority — check `get_source_reputation` when precision matters
- `get_source_reputation` — the learned trust profile of each side's source vertical; a disagreement between a high-reputation and a low-reputation source often resolves itself
- `get_fact` / `get_fact_provenance` — audit one competing fact's trust record (incl. `groundingStatus`) and the verbatim turns behind it before retracting (`FACTS_API_ENABLED` servers)
- `get_entity_timeline` — full history including superseded chain (see `brain-recall`)
- `search_knowledge` with `includeContested: true` — surfaces COMPETING facts in search results (see `brain-search`)
