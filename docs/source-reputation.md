# Source reputation & trust

> *A fact isn't true. It's claimed by a source, extracted from evidence, and
> trusted under context.*

Brain treats a source as a first-class citizen, not a string on a fact. Every
fact records **who claimed it** and **how much that claim was trusted at the
moment it was written** — and that trust is decomposed, domain-scoped, and never
silently recomputed. This page explains the model and how to operate it.

Trust is layered on top of — not a replacement for — the conflict resolver
([data model](data-model.md), [bitemporal semantics](bitemporal-semantics.md)).
The resolver still decides who wins a duel; reputation feeds that decision and,
optionally, re-weights retrieval.

## The source key

A source is identified by `sourceKey = <vertical>:<recorder>` (a message from
`rent` recorded by `intake_bot` → `rent:intake_bot`). This is the single
granularity choke point — everything below keys off it. A fact's `source` object
may also carry an `evidence[]` array (`{kind, ref, note?}`, capped) describing
what the claim was extracted from.

## What gets written on every fact

At ingest, inside the resolver, each created fact is stamped with:

- **`trustSnapshot`** — `{ sourceKey, domain, declaredTrust, learnedTrust,
  calculatedAt }`. A *point-in-time* reputation reading. It is written once and
  never back-filled: replay the graph and you see the trust that actually drove
  the decision, not today's opinion of it.
- **`conflictTrace`** (on a fact that won or is `COMPETING`) — the resolver's
  `{ scoreBreakdown, dominantDimension, slotDelta, bestOpponentId, decidedAt }`.
  The "because" behind the outcome.

## Domain-scoped reputation

Reputation is **per (source, domain)**, not one global scalar. In v1 the domain
axis is the predicate (stored as a generic `domain` string, so a topic layer can
be added later without a migration). A broker may be highly reliable on
`listing_price` and useless on `zoning` — one number can't express that.

The learned score lives in `source_trust` (keyed unique on `sourceKey, domain`,
with `winCount` / `lossCount` / `lastSeenAt`), refreshed by the nightly
calibration refit; every meaningful change is appended to `source_trust_history`
(an audit trail, never overwritten). Lookup is a ladder via
`fn::source_trust_scoped`:

1. the `(sourceKey, domain)` score if it has ≥ 8 samples, else
2. the source's global `(sourceKey, domain = NONE)` score if it has ≥ 8, else
3. a neutral `0.5`.

The winner/loser asymmetry from the resolver is preserved: a winner is scored by
a static heuristic, a loser by its learned agreement rate.

## Source registry & authority

Operators can declare a source in `source_registry` (`type` ∈ `human`,
`website`, `document`, `api`, `agent`, `sensor`, `system`; `authLevel` 0..1;
`owner`; `note`). A declared `authLevel` activates the resolver's authority slot
via `fn::source_authority_of` — an opt-in, per-source lever (a government
registry can be given standing that an anonymous scrape isn't). Unregistered
sources resolve byte-identically to before, so this is never a flag day.

Manage it over REST (all `brain:admin`):

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/admin/sources` | registry ⋈ trust, one row per source |
| `GET` | `/v1/admin/sources/:sourceKey` | detail: per-domain trust rows + history + recent facts |
| `PUT` | `/v1/admin/sources/:sourceKey` | declare `type` / `authLevel` / `owner` |

Agents can read reputation through the MCP tool **`get_source_reputation`**.

## Corroboration

When a *different* source asserts the **same** object for a fact, that's not a
duel — it's reinforcement. The incoming fact lands as `status = 'corroborating'`
(outcome `CORROBORATED`), and the incumbent accumulates
`corroboration = { count, sourceKeys[], lastAt }`. (The same source re-asserting
is the ordinary supersede-refresh.)

## Trust at read time (opt-in)

By default, retrieval is unchanged. Three env flags let trust move rankings:

- `SEARCH_TRUST_BETA` (β, default `0`) — scales a source-reputation multiplier.
- `SEARCH_CORROBORATION_GAMMA` (γ, default `0`) — rewards corroboration count.
- `SEARCH_AUTHORITY_DELTA` (δ, default `0`) — rewards registry-declared source
  authority (facts from unregistered sources carry authority 0 and are
  unaffected at any δ).

The final score is multiplied by `(1 + β·(reputation − 0.5)) · (1 + γ·min(corroborationCount, 3)) · (1 + δ·authority)`,
so at the defaults it's a byte-for-byte no-op. When `explain` is on, the
response carries the `factTrust` decomposition (reputation, authority, freshness,
calibrated confidence, corroboration, evidence count). A separate
`SYNTHESIZE_MIN_FACT_TRUST` floor (default `0`) can drop low-trust facts from
synthesis citations.

**Rollout:** enable β/γ only after the nightly refit has accumulated scoped
rows for your tenants, and re-measure the quality eval with trust on before
committing to a value.

## What Brain deliberately does *not* do

- No `bias_profile` / `verification_level` dream-fields — only what's computed.
- No retroactive back-fill of snapshots — history is what it was.
- No multiplicative rewrite of the resolver — it stays a tuned weighted sum; the
  multiplicative trust composite is read-time only, behind the flags above.
- Sources are **not** knowledge entities — no embeddings / merge / forget-cascade
  machinery is pointed at them.
