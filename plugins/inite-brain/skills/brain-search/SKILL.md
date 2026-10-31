---
name: brain-search
description: Semantic search over the INITE Brain knowledge graph via the search_knowledge MCP tool. Use when the user wants to find facts, entities, or evidence about people/companies/objects in their tenant, especially when the question is fuzzy or natural-language. Supports bitemporal "as of" queries.
---

# brain-search

Search the company's bitemporal knowledge graph for entities and their facts. Brain's `search_knowledge` MCP tool runs a hybrid pipeline (vector + BM25 + listwise LLM rerank) over per-tenant data and returns ranked entities each with their matched facts.

## When to use

- "Who complained about X?", "find customers in Berlin", "what do we know about Acme Corp?"
- "What was Alice's tier in April?" — historical / as-of queries
- Anything where the user is asking the brain to **recall information**, not record a new fact

Do **not** use for:
- Recording new facts → use `record_fact` instead
- Walking one entity's full history → use `brain-recall` (it combines profile + timeline + connections)
- You already know WHICH entities the question is about → use **`graph_retrieve`** (resolves the named entities, walks their 1-hop neighbourhood, returns facts across seeds ∪ neighbours — "who runs engineering at Acme" lives on a neighbour, not on Acme itself; it soft-fails to empty so you can fall back to `search_knowledge`)
- Questions that combine evidence across multiple entities or sessions → use **`search_multi_hop`** (it runs a planner-LLM and chains sub-queries; the running entity set is anchored across hops so compute stays bounded)
- Direct natural-language answers with citations → use **`synthesize`** (the LLM generator runs a verifier; the strict guardrail returns `null` when grounding is thin, lenient returns the verdict). `answer: null` always comes with a `reason`: on a server in harness mode (`reason: "harness_mode"`) brain spends no model of its own, so read the `evidence` lines it returns and answer from them yourself. `synthesize` and `search_multi_hop` default to `detail: "answer"` (the answer, its citations and compact evidence); `detail: "full"` adds every hit, id and score

## Whose memory — pass `userId`

When you act for a particular person, pass their id as `userId` on every read and write. Brain keeps each person's memory apart from the shared, tenant-wide memory:

- reads with `userId` return the shared facts plus that person's own; reads without it return shared facts only;
- writes with `userId` land in that person's memory; without it they are shared with the whole tenant;
- some views exist only per person: the beliefs in `get_entity_profile` and the belief lines of the focus view.

The Claude Code plugin's hooks capture under the `user_id` you configured; pass the same id, or your calls will not see what the hooks remembered. A user-bound token is pinned to its own user whether or not you pass one.

## How to invoke

```ts
search_knowledge({
  query: "tenants who complained about maintenance",
  limit: 10,            // 1..100, default 10
  predicates: ["complained_about"],  // optional filter
  asOf: "2026-04-01T00:00:00Z",      // optional bitemporal cutoff
  minConfidence: 0.6,    // optional 0..1 floor on fact confidence
  userId: "u_42",        // the person you act for (see above)
})
```

### Choosing parameters

- **`query`** — natural language. Brain's router decomposes intent and routes to predicate-specific embeddings. Plain English wins over keyword soup; "Alice's email" beats "alice email".
- **`limit`** — keep ≤ 10 unless the user explicitly asks for more. Reranker quality degrades past 20.
- **`predicates`** — pass when the user's intent is unambiguous about predicate class (e.g. "phone numbers" → `["phone"]`). When unsure, omit and let the router decide.
- **`asOf`** — ISO 8601 timestamp. **Default behaviour is "actual now"** — only facts true in the real world at request time. Pass `asOf` for historical investigations ("what did we know on April 1?"). See `brain-bitemporal` for full semantics.
- **`minConfidence`** — only set when noise from low-confidence ingest is bothering the user. Default behaviour respects per-predicate trust scores already.

## Reading the result

By default (`detail: "focus"`) the answer is a few lines — only what the query is about, each piece of evidence as the facts or as the turn they were read from, whichever is shorter:

```
Sasha: lives_in = Porto (2026-10-01)
Diego: lives_in = Braga (2026-10-08)
links: Ana sibling_of Sasha; Diego colleague_of Ana
[2026-10-05] sasha: "Update: I sold the Ninja last week, I don't own a motorcycle anymore."
(+11 more: detail "compact")
```

- A fact line is `Entity: predicate = value (since…until) [status]`; a status shows only when the value is not the current one.
- `links:` are the relations connecting the entities shown — the hop a two-step question needs.
- `(+N more …)` is what was left out. Ask for it only if the lines above do not answer the question.
- `detail: "compact"` returns JSON: every fact of the matched entities with `since`/`until`, relations, and `entityId` (what `get_entity_timeline` and `get_entity_profile` take).
- `detail: "full"` adds fact and edge ids, the fused score with its per-leg breakdown, trust keys and external refs (the bridge back to the originating vertical). Ask for it only when you need one of those.
- A memory answer never costs more context than the raw turns it came from; when a turn is cheaper than its facts, you get the turn.

## Common patterns

### Plain question

```
User: "Anyone complain about late maintenance last month?"
→ search_knowledge({ query: "complained about late maintenance",
                     predicates: ["complained_about"],
                     asOf: "<last month end>" })
```

### Historical lookup

```
User: "What was Acme's status on March 15?"
→ search_knowledge({ query: "Acme status",
                     asOf: "2026-03-15T00:00:00Z",
                     limit: 5 })
```

### PII-gated read

If the search needs `email`, `phone`, `dob`, or `address`, the caller must hold the `brain:read_pii` scope. Brain returns the predicate but the `object` field is `null` when the scope is missing — that's a permission signal, not "the data doesn't exist".

## Pitfalls

- **Empty results** ≠ "no such entity". Search is recall-limited; if you suspect the entity exists, rephrase, fall back to `find_related_entities` from a known anchor, or check you passed the right `userId` (a personal fact is invisible without it). For a code anchor use `why`.
- **Don't loop on a single search**. If the first call returns nothing, change the query phrasing or drop the predicate filter — don't retry the same args expecting different output.
- **Latency floor ~300ms**. If the user needs three lookups, batch them as separate calls in parallel rather than sequencing.

## Companion tools

- `graph_retrieve` — graph-first retrieval when the entities are already known by name; predicateHints narrow the neighbour facts
- `search_multi_hop` — for chained reasoning over multiple entities ("tenants who complained in April AND upgraded after"); set `synthesize: true` to fold the answer in
- `synthesize` — when the user wants a direct natural-language answer with citations rather than raw search hits; pair with `synthesisGuardrails: 'strict'` when hallucinated answers cost more than null
- `memory_diff` — for "what changed between two cursors" questions (see `brain-bitemporal`)
- `summarize_entity` — one-line briefing when full profile is overkill (see `brain-recall`)
- `get_entity_profile` — when you already have a specific entity in mind
- `get_entity_timeline` — when you need every fact ever recorded for one entity
- `get_fact` / `get_fact_provenance` — the full trust record and grounding turns behind one factId a search surfaced (`FACTS_API_ENABLED` servers)
- `get_competing_facts` / `detect_contradiction` — adjudication and preflight (see `brain-conflict`)
- `get_source_reputation` — how much to trust a hit's source vertical
- `find_related_entities` — graph walk from a known node
- `why` / `recall_decisions` — code-memory recall: the recorded "why" behind a code anchor / semantic search over recorded decisions
- `record_fact` / `link_entities` / `retract_fact` — write surface (see `brain-write`)
- `forget_entity` — GDPR-grade hard cascade; admin scope only
