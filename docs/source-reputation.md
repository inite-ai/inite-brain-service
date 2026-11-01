# Source reputation & trust

How Brain models who claimed a fact and how much that claim is trusted —
for operators tuning trust and consumers reading it.

> *A fact isn't true. It's claimed by a source, extracted from evidence, and
> trusted under context.*

Brain treats a source as a first-class citizen, not a string on a fact. Every
fact records **who claimed it** and **how much that claim was trusted at the
moment it was written** — and that trust is decomposed, domain-scoped, and never
silently recomputed. This page explains the model and how to operate it.

Trust is layered on top of — not a replacement for — the conflict resolver
([data model](data-model.md), [bitemporal semantics](bitemporal-semantics.md)).
The resolver decides by valid time alone (#830, migration 0177): reputation is
recorded on each fact as provenance, never as a vote in that decision, and it
can optionally re-weight retrieval.

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
  never back-filled: replay the graph and you see the trust the source had when
  it made the claim, not today's opinion of it.
- **`conflictTrace`** (on a fact that closed earlier values or competes by
  event day) — `{ decidedBy, supersededFactIds | competingFactIds,
  bestOpponentId, decidedAt }`, where `decidedBy` is `'valid_time'` or
  `'event_day'`. There is no score breakdown: no weight decided the outcome.

## Domain-scoped reputation

Reputation is **per (source, domain)**, not one global scalar. In v1 the domain
axis is the predicate (stored as a generic `domain` string, so a topic layer can
be added later without a migration). A broker may be highly reliable on
`listing_price` and useless on `zoning` — one number can't express that.

The learned score lives in `source_trust` (keyed unique on `sourceKey, domain`,
with `winCount` / `lossCount` / `lastSeenAt` / `method`), refreshed by the
nightly truth-discovery pass described below; every meaningful change is
appended to `source_trust_history` (an audit trail, never overwritten). Lookup
is a ladder via `fn::source_trust_scoped`:

1. the `(sourceKey, domain)` score if it has ≥ 8 samples, else
2. the source's global `(sourceKey, domain = NONE)` score if it has ≥ 8, else
3. a neutral `0.5`.

The learned rate is frozen into the fact's `trustSnapshot.learnedTrust` at
write time.

## Truth discovery: how the score is learned

Each night, per tenant, the refit fits **Dawid–Skene** over the tenant's facts
(`src/ai/calibration/truth-discovery.ts`, #847). It estimates which value of a
contested slot is probably true and how accurate each source is, both at once.
No model is called, and there are no hand-set weights.

- **What competes.** Facts on the same single-valued slot (entity, canonical
  predicate, user, team tags, derived world) whose valid times overlap and
  whose values differ. A value that *succeeded* another in valid time is
  history, not its rival, so a source that reports a change is never marked
  wrong for it. (The win/loss tally this replaced counted every superseded
  fact as a loss.) A value closed the instant it began still claimed that
  instant: a `single_active` slot's last write does not make an earlier
  disagreement disappear. An uncontested value that two or more origins
  restate counts as agreement; a lone value says nothing about anyone.
- **One vote per origin.** Facts sharing an `originKey` (one document ingested
  twice, a forwarded message) are one vote, so copies cannot outvote an
  independent source.
- **Priors.** Accuracy is a Beta posterior with 16 pseudo-votes, chosen by
  `pnpm eval:truth-discovery` on held-out seeds. Per domain it shrinks
  towards the source's accuracy across domains, and that towards a declared
  `authLevel`, else 0.5.
- **Anchors.** `helpful` feedback clamps a value true; `incorrect` feedback
  and a retraction clamp it false. One actor counts once per (source, domain,
  verdict).
- **Outputs.** The `source_trust` rows (`method: 'dawid_skene'`;
  `sampleCount` = votes, `winCount` = the expected right ones). Rows of
  sources that took part in no contest are removed, so the lookup falls back
  to 0.5. Every fact of a contested slot also gets `truth = { posterior,
  claims, model, computedAt }`, the probability that its value is the true
  one. That is a read-side estimate; it never supersedes, retracts or hides
  anything.
- **Served.** Search hits and the entity profile carry `truth` on a
  contested fact. The focus view marks it `[competing, likely 0.82]`, and the
  profile gist lists a dispute's values most likely first. The rival stays in
  view.

On the battery (sources of known accuracy, copiers, a source that reports
changes; 10 seeds the prior was not tuned on), it picks the true value 92.7%
of the time against 84.5% for majority vote. Its calibration error is 0.026,
and it recovers source accuracy with RMSE 0.037 where the win/loss tally had
0.364.

## Source registry & authority

Operators can declare a source in `source_registry` (`type` ∈ `human`,
`website`, `document`, `api`, `agent`, `sensor`, `system`; `authLevel` 0..1;
`owner`; `note`). A declared `authLevel` (read via `fn::source_authority_of`) is
provenance: it rides the fact's trust snapshot and feeds the read-time
authority term (`SEARCH_AUTHORITY_DELTA`, below), so a government registry can
rank above an anonymous scrape. It does not decide write-time conflicts, which
follow valid time.

Manage it over REST (all `brain:admin`):

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/admin/sources` | registry ⋈ trust, one row per source |
| `GET` | `/v1/admin/sources/:sourceKey` | detail: per-domain trust rows + history + recent facts |
| `PUT` | `/v1/admin/sources/:sourceKey` | declare `type` / `authLevel` / `owner` |

Read-only trust inputs are also served to any `brain:read` key:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/sources` | catalogue: declared ⋈ learned; filters `domain` / `type` / `minSamples`; paginated (`limit` ≤ 200 / `offset`) |
| `GET` | `/v1/sources/:sourceKey` | detail: declared identity + trust scopes + history (newest first, ≤ 50) |

The public projection excludes the operator annotations (`owner`, `note`) and
the registry row timestamps — those stay on the `brain:admin` surface. With
`?domain=` the list additionally carries that domain's learned rate per source
(`domainTrust`), and `minSamples` judges the domain-scoped row (global
fallback).

Agents can read reputation through the MCP tool **`get_source_reputation`**.
(The MCP tool currently returns the full admin shape including `owner`/`note`;
aligning it with the public projection is a tracked follow-up.)

## Corroboration

When a *different* source asserts the **same** object for a fact, that's not a
duel — it's reinforcement. The incoming fact lands as `status = 'corroborating'`
(outcome `CORROBORATED`), and the incumbent accumulates
`corroboration = { count, sourceKeys[], lastAt }`. (The same source re-asserting
is the ordinary supersede-refresh.)

Ingest-time matching is EXACT object equality. The same claim worded
differently is picked up later by the nightly fuzzy pass
(`DREAMS_CORROBORATE_ENABLED`, default off): cosine-similar same-predicate
pairs from different origins go to an LLM judge, and a `same_assertion`
verdict applies the identical corroboration write — the counter still only
grows per distinct origin.

## Retrieval feedback (0054)

Consumers close the loop through `POST /v1/feedback` (MCP:
`record_feedback`): `helpful` counts as a win for the fact's source at the
nightly refit, `incorrect` as a loss — the same currency as
supersede/corroboration outcomes, so feedback moves ranking through the
already-shipped `SEARCH_TRUST_BETA` multiplier. One standing vote per
(fact, caller key) — repeat feedback replaces the verdict, so a single
consumer cannot farm its own source's rate. `not_helpful` is stored as a
relevance signal but deliberately does not touch reliability.

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
- No trust in the resolver — write-time conflicts follow valid time, and a
  same-moment disagreement goes to fact resolution's judge; the
  multiplicative trust composite is read-time only, behind the flags above.
- Sources are **not** knowledge entities — no embeddings / merge / forget-cascade
  machinery is pointed at them.

## See also

- [Data model](data-model.md) — where the trust snapshot lives on a fact.
- [Document pipeline](document-pipeline.md) — origin-keyed corroboration for multi-reader documents.
- [External indexer protocol](indexer-protocol.md#trust-earned-not-granted) — how a new indexer earns weight.
- [Operations](operations.md#retrieval-feature-flags) — the β/γ/δ ranking flags.
