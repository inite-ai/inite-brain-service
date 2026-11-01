---
name: brain-recall
description: Recall everything brain knows about one specific entity — current profile, full bitemporal timeline, graph neighbours, and unresolved disagreements. Use when the user names a person/company/thing and asks "tell me about them", "what's their history", or "what do we still disagree about?". For a single-shot LLM briefing without three round-trips, reach for summarize_entity instead.
---

# brain-recall

When the user points at one entity and asks for the full picture, combine MCP tools in order:

- `summarize_entity` (one-liner briefing — drop into LLM context)
- `get_entity_profile` (now-snapshot — name, refs, active facts)
- `get_entity_timeline` (history — every fact, including retracted)
- `find_related_entities` (graph context — typed edges)
- `get_competing_facts` (unresolved disagreements — pairs the resolver left for adjudication)

Each addresses a different question and the user usually wants pieces of several. The new short-circuit is `summarize_entity` — when the user just wants a single line of context about an entity (not all the facts), it's one call instead of three.

## When to use

- "Tell me about Alice Smith."
- "What's the full history on Acme Corp?"
- "Who is Bob connected to?"
- "What changed for tenant 42 over the last quarter?"

Do **not** use for:
- Open-ended search where the entity isn't yet identified → use `brain-search` first
- Recording new facts → `record_fact`

## Whose memory — pass `userId`

When you act for a particular person, pass their id as `userId` on every read and write. Brain keeps each person's memory apart from the shared, tenant-wide memory:

- reads with `userId` return the shared facts plus that person's own; reads without it return shared facts only;
- writes with `userId` land in that person's memory; without it they are shared with the whole tenant;
- some views exist only per person: the beliefs in `get_entity_profile` and the belief lines of the focus view.

The Claude Code plugin's hooks capture under the `user_id` you configured; pass the same id, or your calls will not see what the hooks remembered. A user-bound token is pinned to its own user whether or not you pass one.

## How to invoke

Identifying the entity:

- If the user gave a brain entity id (`knowledge_entity:01HXYZ...`), pass it directly.
- If the user named a person/company, call `search_knowledge({ query: "<name>", limit: 3, detail: "compact", userId })` first and take `results[].entityId` (the default focus view is text and carries no ids). Confirm with the user if there's ambiguity ("I found two Acmes — Inc and LLC. Which?").
- If the user gave an id from another system (`cust_42` in the rental app), search for it the same way: `get_entity_profile` takes brain entity ids only. For a code anchor (a file path or symbol) use `why`.
- On a connection with the `core` tool profile, `get_entity_profile`, `get_entity_timeline` and `summarize_entity` are reached through `find_tool` / `run_tool`.

### Step 0 — briefing (the cheap path)

If the user just wants context, not the full graph:

```ts
summarize_entity({
  entityId: "knowledge_entity:01HXYZ...",
  styleHint: "neutral", // 'neutral' | 'sales' | 'support' | 'client_llm'
})
```

Returns a one-line briefing — name, type, top 6 most-confident facts, externalRefs. Cached in-process per (entityId, asOf, styleHint), so a hot entity touched across many turns doesn't reload the profile. Use this BEFORE reaching for `get_entity_profile` if all you need is "tell me about them in one breath".

`styleHint: 'client_llm'` opts into MCP sampling: brain asks YOUR client (Claude Desktop / agent runtime) to phrase the one-liner with its own model — zero brain-side LLM cost. Falls back to the neutral template (`sampledBy: 'local_template'`) when the client doesn't advertise the sampling capability.

When you do need more than a line, drop down to Step 1.

### Step 1 — profile (now snapshot)

```ts
get_entity_profile({
  entityId: "knowledge_entity:01HXYZ...",
  userId: "u_42",
  asOf: undefined,  // omit for "now"
})
```

By default (`detail: "text"`) you get the entity at a glance: its current state as beliefs, one line per attribute with the value it replaced (`queue_backend: NATS JetStream (was: Redis Streams) — since 2026-03-18`), the facts in dispute, and an index of every attribute with recorded facts. Beliefs are personal, so without `userId`, or before any belief is built, the text lists the facts instead. `detail: "compact"` lists every current fact, one line per attribute; `detail: "full"` is JSON with fact ids and externalRefs (cross-vertical ids).

### Step 2 — timeline (full bitemporal sweep)

```ts
get_entity_timeline({
  entityId: "knowledge_entity:01HXYZ...",
  userId: "u_42",
  since: "2026-01-01T00:00:00Z",  // optional lower bound on when brain learned it
  until: undefined,                // open-ended
})
```

By default (`detail: "text"`) the timeline reads as a history: the conversations (scenes) the entity's facts came from, oldest first, each with a short gist and the entity's state changes in it (`queue_backend: Redis Streams → NATS JetStream`), then one line per fact that came from no conversation (direct writes, documents).

For the audit trail ask for `detail: "compact"` (JSON with fact ids) or `"full"` (adds sources and confidence). It is a list of events: `{ type: "fact.recorded", at, validFrom, factId, predicate, object }` when brain learned a fact (`at` = when it learned it, `validFrom` = when it became true), and `{ type: "fact.retracted", at, factId, reason, supersededBy }` when one was walked back.

Use this when the user asks:
- "What did we know on X?" — keep `fact.recorded` events with `at <= X` and drop those retracted by then
- "Did anything get walked back?" — the `fact.retracted` events
- "When did the tier change?" — the state changes in the text, or `tier` events ordered by `validFrom`

### Step 3 — connections (graph context)

```ts
find_related_entities({
  entityId: "knowledge_entity:01HXYZ...",
  kind: undefined,  // optional edge filter, e.g. "paid_for", "mentioned_in", "identity_of"
})
```

Returns typed edges and the entities on the other side. Useful for "who else is involved" / "what did they touch" / "merged-with" questions. Edge `kind` filter is open-vocabulary — common kinds include `identity_of` (cross-vertical merge), `paid_for`, `mentioned_in`, `manages`, `member_of`.

### Step 4 — competing facts (unresolved disagreements)

```ts
get_competing_facts({
  entityId: "knowledge_entity:01HXYZ...",
  predicate: undefined,         // optional — filter to one predicate
  asOf: undefined,              // optional — what was competing then
})
```

Returns facts in COMPETING status — pairs (or 3+ groups) the conflict resolver couldn't auto-supersede because they overlap in valid-time and are too cosine-close within margin. Use when the timeline shows two conflicting beliefs and you want to surface the disagreement to the user for adjudication. See `brain-conflict` for resolution workflow.

## Composing a recall

Decide how much to fetch based on the user's question:

| Question shape | Summarize | Profile | Timeline | Connections | Competing |
| --- | --- | --- | --- | --- | --- |
| "Tell me about X" (one line) | ✓ | — | — | — | — |
| "Tell me about X" (short) | — | ✓ | — | — | — |
| "Full picture on X" | — | ✓ | ✓ | ✓ | ✓ |
| "What changed about X?" | — | — | ✓ | — | — |
| "Who's X connected to?" | — | ✓ | — | ✓ | — |
| "What did we know on April 1?" | ✓ (with `asOf`) | ✓ (with `asOf`) | — | — | — |
| "What's still being disagreed about?" | — | — | — | — | ✓ |

Don't always pull all five. Each call is a round-trip; spending one when the user asked for the other is rude.

## Reading retracted rows

A retracted fact is **not deleted**. It stays in the timeline's audit trail as a `fact.retracted` event with its time and reason. Two valid surfaces:

- **Default UX** — hide retracted from the user unless they ask "anything walked back?"
- **Audit UX** — show them inline with a strikethrough or `(retracted: <reason>)` annotation

Never lie that the fact never existed. Brain holds the audit trail precisely so you can show "we used to believe X, then learned otherwise on Y".

## Pitfalls

- **`get_entity_profile` with stale `asOf`** — if you pass `asOf` from a previous turn, you'll get the snapshot from then, not now. Either drop the arg or freshen it to current time.
- **The audit trail can be large**. The default text is the compact view; for the JSON of a long-lived entity use `since`/`until` to window it.
- **Graph walks aren't transitive in one call**. `find_related_entities` returns 1-hop neighbours. For 2+ hops, walk recursively — but stop at 3 hops or the answer drowns in noise.

## Companion tools

- `search_knowledge` — when entity isn't yet identified
- `graph_retrieve` — when you know the entity NAMES and want what the graph knows around them in one call
- `search_multi_hop` — when the user's question chains evidence across entities
- `memory_diff` — when the question is "what changed in the last week / since last conversation?" (see `brain-bitemporal`)
- `get_fact` / `get_fact_provenance` — "why do you remember this?": one fact's full trust record (incl. `groundingStatus`) and the verbatim conversation turns behind it (`FACTS_API_ENABLED` servers)
- `record_fact` / `link_entities` / `retract_fact` — write surface (see `brain-write`)
- `get_competing_facts` + `detect_contradiction` — adjudication workflow (see `brain-conflict`)
