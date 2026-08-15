# Bitemporal semantics

Brain stores facts on two independent time axes:

- **valid_time** — `validFrom` / `validUntil` — when the fact was/is true in the **real world**
- **transaction_time** — `recordedAt` / `retractedAt` — when **brain knew** about it

This document is the single source of truth for how default search interprets these axes, when to write each one at ingest time, and when callers should reach for `asOf` vs `includeStale`.

## Default search = "actual now" (Datomic / Zep convention)

Without `asOf`, brain's default search returns only **currently true** facts:

```sql
AND retractedAt IS NONE                                  -- we still know about it
AND validFrom <= time::now()                             -- it has already started
AND (validUntil IS NONE OR validUntil > time::now())     -- it hasn't ended yet
AND status NOT IN ['superseded', 'compacted']            -- not explicitly retired
```

Why this default — 95% of memory-layer callers (LLM agents, customer-data dashboards, support tooling) want "what's true right now". The audit shape — every active-status fact ever ingested — is the exception, served by an explicit parameter:

| Caller intent | Pass |
|---|---|
| "What's true right now?" | (default — no extra flags) |
| "What was true on date X?" | `asOf: "2026-04-01T00:00:00Z"` |
| "Show me everything we have" | `includeStale: true` |
| "Show me retracted facts too" | `includeRetracted: true` (composes with the above) |

This is a **breaking change** from the v0.1.0 default which returned every active-status fact regardless of validity window. Existing audit-style callers must opt in via `includeStale: true` or use the entity timeline endpoint.

## When to write `validUntil` at ingest

Two patterns:

**Pattern A — known-end intervals (write `validUntil`).** Use when the operator knows in advance when a fact stops being true. A 12-month tier upgrade promotion, a fixed-term lease, an event registration: `tier=platinum, validFrom=2026-01-01, validUntil=2027-01-01`. Brain's bitemporal closure cleanly removes the fact from default search the moment its window closes; no compaction lag.

**Pattern B — open-ended truth (leave `validUntil` unset).** Use when the fact is true until further notice. A customer's current tier, a phone number, a profile name: `tier=platinum, validFrom=2026-01-01`. New facts on the same `(entity, predicate)` either supersede this one (margin-wins) or coexist as competing pairs (margin-loses, `status='competing'`).

The two patterns compose cleanly through Allen's interval algebra (see below): a Pattern-A fact with explicit `validUntil` followed by a Pattern-B fact starting at that boundary forms a clean timeline, NOT a conflict.

## Allen's interval algebra in conflict resolution

The conflict resolver (`fn::resolve_fact`) checks `(entity, predicate, semantics)` against existing active facts. For **bitemporal** predicates, "competing" candidates are now **double-gated**:

1. **Cosine ≥ threshold** — the new fact must be about the same object (this filters out `tier=gold` vs `tier=platinum` from looking like a contradiction with `tier=silver`).
2. **Allen's overlap** — `fn::intervals_overlap(a.validFrom, a.validUntil, b.validFrom, b.validUntil)` — the validity intervals must overlap.

Sequential intervals (older's `validUntil` ≤ newer's `validFrom`) are NOT competing. The older fact is just historical; the newer one is the natural successor. This is exactly the clean tier-ladder pattern: `standard → gold → platinum`, each with its own validity window, all sitting in `status='active'` but only the current one surfacing in default search.

Open-ended intervals (`validUntil IS NONE`) are treated as extending to +∞:

| New interval | Old interval | Overlap? |
|---|---|---|
| `[Apr1, ∞)` | `[Jan1, Apr1)` | No — sequential, no conflict |
| `[Apr1, ∞)` | `[Jan1, ∞)` | Yes — both open-ended, conflict (margin / supersede) |
| `[Mar15, ∞)` | `[Jan1, Apr1)` | Yes — overlap on `[Mar15, Apr1)`, conflict |
| `[Apr1, May1)` | `[Apr15, ∞)` | Yes — overlap on `[Apr15, May1)`, conflict |

Single-active predicates (`name`, `email`, `phone`, `dob`) bypass the overlap check — by definition only one row at a time, every prior active conflicts with the new one. Append-only (`said`, `complained_about`, `interacted_with`) never conflict — but since migration 0082 they DO corroborate: an exact-object claim from a different origin strengthens the incumbent (`status='corroborating'`) instead of piling up as a duplicate active row.

### Coined predicates: canonical alias + append_only (migration 0082)

The dialogue extraction profile (open vocabulary) keeps the SPECIFIC predicate the extractor coined — `painted_seascape`, not `hobby`. Two consequences, both engine-wide invariants:

1. **Resolution keys on the canonical form.** The EDC canonicalization the extraction prompt promises runs as an *alias pass*: the coinage stays in `predicate`, the registry's canonical id lands in `knowledge_fact.predicateAlias`, and the resolver (plus dedup, the diversity cap, chatter demotion, and the dreams sweeps) key on `predicateAlias ?? predicate`. Closed-vocabulary tenants never populate the alias, so their keys are byte-identical to pre-0082.
2. **Unknown predicates default to `append_only`, not `bitemporal`.** A predicate absent from the registry is an open-vocabulary observation; supersede/compete semantics were designed for closed CRM predicates and made every coined fact take the serialized per-fact mutex path. Seed and operator-declared predicates keep their per-predicate policies. Two seed-keyed carve-outs deliberately do NOT follow the fallback: dreams-corroborate sweeps coined groups (fuzzy same-assertion is what collapses re-worded coinages) while still skipping seed append_only event history, and episodic promotion folds ONLY seed append_only predicates (a `summary_<coinage>` row would trade recall drivers for a paraphrase).

## What changes for callers

If you previously did:

```ts
brain.search({ query: 'Maya tier' });
// → returned every tier fact ever ingested for Maya
```

You now get:

```ts
brain.search({ query: 'Maya tier' });
// → returns ONLY the currently-true tier (typically the latest one
//    with validUntil unset, or the one whose validity window contains now())
```

To restore the old behaviour explicitly:

```ts
brain.search({ query: 'Maya tier', includeStale: true });
```

For point-in-time queries (audit / counterfactual / "what did we tell the customer last quarter"):

```ts
brain.search({ query: 'Maya tier', asOf: '2026-03-01T00:00:00Z' });
```

The entity-timeline endpoint (`GET /v1/entities/:id/timeline`) is unchanged — it always returns the full audit shape, gated by `recordedAt`.

## Why not just filter `validUntil` post-hoc on the JS side?

Two reasons:

1. **Cost** — filtering after the SurrealDB query means we pull every stale fact across the wire and discard it. For a tenant with 10 years of tier history that's 100× the data we need.
2. **Index alignment** — the SurrealDB HNSW + BM25 indexes can use `validUntil > now()` as part of their selection, not just as a post-filter. Pushing the closure into the WHERE clause keeps index scans tight.

## Rationale (research notes)

The "actual now" default is the convention in:

- **Datomic** — every database value is an immutable point in time; reads default to "as of last transaction" (i.e. now), audit reads use `asOf` / `since` / `history`.
- **TerminusDB** — bitemporal RDF with `valid_time` graphs, default queries are time-conditioned.
- **Graphiti / Zep** (Jan 2025) — bitemporal KG specifically for AI-agent memory; default search is "current truth", `as_of` for historical context. Cited in the research that informed this design.

Brain follows the same family. The `includeStale` flag exists for exotic callers (admin tooling, batch jobs that build full-history exports), not as a mode toggle for normal application code.

## See also

- [Data model](data-model.md) — the fact shape these axes live on.
- [Architecture](architecture.md) — how the cutoff pushes into the retrieval WHERE clause.
- [API reference](api.md) — `asOf` / `includeStale` / timeline endpoints.
