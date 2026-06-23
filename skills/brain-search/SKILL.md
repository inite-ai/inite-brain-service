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
- Questions that combine evidence across multiple entities or sessions → use **`search_multi_hop`** (it runs a planner-LLM and chains sub-queries; the running entity set is anchored across hops so compute stays bounded)
- Direct natural-language answers with citations → use **`synthesize`** (the LLM generator runs a verifier; the strict guardrail returns `null` when grounding is thin, lenient returns the verdict)

## How to invoke

```ts
search_knowledge({
  query: "tenants who complained about maintenance",
  limit: 10,            // 1..50, default 10
  predicates: ["complained_about"],  // optional filter
  asOf: "2026-04-01T00:00:00Z",      // optional bitemporal cutoff
  minConfidence: 0.6,    // optional 0..1 floor on fact confidence
})
```

### Choosing parameters

- **`query`** — natural language. Brain's router decomposes intent and routes to predicate-specific embeddings. Plain English wins over keyword soup; "Alice's email" beats "alice email".
- **`limit`** — keep ≤ 10 unless the user explicitly asks for more. Reranker quality degrades past 20.
- **`predicates`** — pass when the user's intent is unambiguous about predicate class (e.g. "phone numbers" → `["phone"]`). When unsure, omit and let the router decide.
- **`asOf`** — ISO 8601 timestamp. **Default behaviour is "actual now"** — only facts true in the real world at request time. Pass `asOf` for historical investigations ("what did we know on April 1?"). See `brain-bitemporal` for full semantics.
- **`minConfidence`** — only set when noise from low-confidence ingest is bothering the user. Default behaviour respects per-predicate trust scores already.

## Reading the result

Each hit looks like:

```json
{
  "entity": {
    "id": "knowledge_entity:01HXYZ...",
    "name": "Alice Smith",
    "type": "person",
    "externalRefs": [{ "vertical": "rent", "id": "cust_42" }]
  },
  "facts": [
    { "factId": "...", "predicate": "tier", "object": "platinum",
      "validFrom": "2026-04-01T00:00:00Z", "confidence": 0.92 }
  ],
  "score": 0.81
}
```

- **`entity.externalRefs`** is the bridge back to the originating vertical — use it to rehydrate the live record via `@inite/api-kit` if the user wants to act on the result. Brain is *system of insight*, not record.
- **`facts[]`** are pre-filtered to the bitemporal window of the query. A fact you don't see in the result either didn't match the query, was retracted before `asOf`, or was outside `validFrom..validUntil`.
- **`score`** is the post-rerank fused score. Treat it as ordinal, not calibrated probability.

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

- **Empty results** ≠ "no such entity". Search is recall-limited; if you suspect the entity exists, fall back to `find_related_entities` from a known anchor, or ask the user for a vertical+id pair you can pass to `get_entity_profile` directly.
- **Don't loop on a single search**. If the first call returns nothing, change the query phrasing or drop the predicate filter — don't retry the same args expecting different output.
- **Latency floor ~300ms**. If the user needs three lookups, batch them as separate calls in parallel rather than sequencing.

## Companion tools

- `search_multi_hop` — for chained reasoning over multiple entities ("tenants who complained in April AND upgraded after"); set `synthesize: true` to fold the answer in
- `synthesize` — when the user wants a direct natural-language answer with citations rather than raw search hits; pair with `synthesisGuardrails: 'strict'` when hallucinated answers cost more than null
- `get_entity_profile` — when you already have a specific entity in mind
- `get_entity_timeline` — when you need every fact ever recorded for one entity
- `find_related_entities` — graph walk from a known node
- `link_entities` — declare a typed edge (e.g. `identity_of` to merge two records of the same person)
- `forget_entity` — GDPR-grade hard cascade; admin scope only
