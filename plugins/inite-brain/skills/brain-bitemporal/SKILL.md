---
name: brain-bitemporal
description: How to query the INITE Brain knowledge graph across time — the asOf parameter, validFrom/validUntil semantics, reading retracted facts, and the memory_diff "what changed between two cursors" surface. Use when the user's question has a temporal dimension ("on X date", "before Y", "what's new since last conversation").
---

# brain-bitemporal

Brain is a bitemporal store. Every fact carries **two** time axes — when it was true in the real world (`validFrom`/`validUntil`) and when brain knew about it (`recordedAt`/`retractedAt`). Most agent code can stay on the "actual now" default; this skill is for when the user's question demands otherwise.

## The two axes

| Axis | Field pair | Meaning |
| --- | --- | --- |
| Valid time | `validFrom` / `validUntil` | When the fact was true in the world. `validUntil` open-ended (`null`) means "still true". |
| Transaction time | `recordedAt` / `retractedAt` | When brain learned the fact / when brain learned it was wrong. `retractedAt = null` means "still believed". |

Examples:

- Alice was *gold tier* from 2026-02-01 to 2026-04-01, then upgraded to *platinum* — two facts, sequential `validFrom`/`validUntil`. Neither is wrong; one succeeds the other.
- Brain recorded Alice's tier on 2026-03-15 from an inbox message, then learned on 2026-04-10 that the message was misattributed — fact retracted, but the row stays for audit.

## The default is "actual now"

Without `asOf`, every brain query returns only facts currently true in the world AND currently believed by brain:

```
validFrom <= now AND (validUntil IS NULL OR validUntil > now)
AND status NOT IN ('superseded', 'retracted', 'compacted')
AND (retractedAt IS NULL OR retractedAt > now)
```

This matches the Datomic / Zep convention and is almost always what callers want. If you're not sure whether to pass `asOf`, **don't**.

## "What changed?" — the memory_diff surface

When the user asks **"what's new since last time"** / **"what changed in the last week"** / **"diff between two points in time"**, don't fetch the timeline and diff it yourself — use `memory_diff`:

```ts
memory_diff({
  from: "2026-05-15T00:00:00Z",
  to:   "2026-05-22T00:00:00Z",
  entityIds: undefined,         // optional — scope to a set of entities
  predicates: ["status", "tier"], // optional — scope to a predicate family
})
```

Returns five buckets for the half-open window `[from, to)`:

- `createdFacts` — net-new active facts (excludes rows that were superseded in-window — those go in changedFacts so consecutive diffs never double-count)
- `retractedFacts` — pure retracts with no successor
- `changedFacts` — superseded transitions, each carrying `{ before, after }`
- `newEntities` — `knowledge_entity.createdAt` in-window
- `forgottenEntities` — GDPR-erased tombstones in-window

The killer use case: a session-resume agent fetches `memory_diff(lastSessionEnd, now)` and uses the result to brief the user on what brain learned while they were away. Cheaper than re-fetching every relevant profile from scratch.

Consecutive diffs over adjacent windows compose: `diff(T0, T1)` + `diff(T1, T2)` covers `[T0, T2)` without double-counting because the window is half-open.

`asOf` is also available on `search_multi_hop` — the planner threads the cursor through every hop, so a historical multi-hop question (e.g. "what tenants in April had been complaining since March?") works the same way as a single-hop search.

## When to pass `asOf`

Three legitimate cases:

### 1. Historical question

```
"What was Alice's tier on March 15?"
→ search_knowledge({ query: "Alice tier", asOf: "2026-03-15T00:00:00Z" })
```

Returns the fact that was valid on that date.

### 2. "What did we know" investigation

```
"On April 1, what did brain believe about this dispute?"
→ get_entity_profile({ entityId: "...", asOf: "2026-04-01T00:00:00Z" })
```

Returns the snapshot of beliefs as of that wall-clock moment — including facts that have since been retracted but were believed then.

### 3. Pre-incident reconstruction

```
"Before the migration on May 5, what status was tenant X in?"
→ get_entity_profile({ entityId: "...", asOf: "2026-05-04T23:59:59Z" })
```

Same as case 2 but with a sharper temporal frame — useful for postmortems where you need to prove "the data we were acting on said Y".

## Reading retracted facts in timeline

`get_entity_timeline` returns the audit trail — retracted facts included. Each row carries:

```json
{
  "factId": "...",
  "predicate": "tier",
  "object": "platinum",
  "validFrom": "2026-04-01T00:00:00Z",
  "validUntil": null,
  "recordedAt": "2026-04-02T08:33:00Z",
  "retractedAt": "2026-04-10T14:00:00Z",   // ← present means retracted
  "retractionReason": "Source misattributed; was Bob, not Alice.",
  "status": "retracted"
}
```

How to surface to the user:

- **Default**: hide retracted unless the user asked for history. The agent's job is to answer the question, not perform an audit.
- **Audit mode**: list retracted with a strikethrough or `(retracted: <reason>)` suffix. Never claim it never existed.
- **"What changed?"**: diff the timeline grouped by `predicate`. Each predicate's currently-active fact is the head of a chain; older versions sit behind it.

## Common pitfalls

### Confusing the two axes

"What was true in March" (valid time) is different from "what brain knew in March" (transaction time). The `asOf` parameter in brain currently filters on the **valid-time axis** with retracted-row gating against the same instant. If you genuinely need a transaction-time-only query (rare — usually only postmortems), pull the full timeline and filter by `recordedAt` client-side.

### Passing an `asOf` from a previous turn

If the user asked an as-of question, then asks a follow-up "and what about her email?", **drop the `asOf`** unless they say "still on April 1". Sticky `asOf` is a footgun.

### Reading a `validUntil` as "expired"

A fact with `validUntil = 2026-04-01` was true *up to* that moment. It's not "stale data" — it's bitemporally correct. Don't filter it out client-side; brain already did the right thing.

### Treating `single_active` predicates like `bitemporal`

Some predicates are `single_active` (e.g. `name`, `email`, `phone`): there can be only one active value at a time. New value supersedes old, no overlapping windows. Other predicates are `bitemporal` (`status`, `intent`, `address`): values are explicitly tagged with a window and can overlap with retracted but never with active. Conflict resolver scores both kinds the same; the semantics differ only at read time. Full table at `/docs/concepts/predicates`.

## When in doubt

Default to no `asOf`. Brain's "actual now" answers ~95% of agent questions correctly. Reach for `asOf` only when the user's question explicitly contains a date / "before X" / "what did we know" phrasing.

## "When did we first learn this?"

The `recordedAt` axis on `get_entity_timeline` is the transaction-time question. Sorting the timeline by `recordedAt` gives you brain's learning order; sorting by `validFrom` gives the real-world order. They're often different — a fact "valid from 2026-01-01" might be `recordedAt = 2026-05-12` if a backfill landed late.

## Companion docs

- `/docs/concepts/bitemporal` — full semantics with Allen-interval-algebra examples
- `/docs/concepts/conflict-resolution` — how brain decides which fact wins when two ingests overlap
