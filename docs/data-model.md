# Data model

What Brain stores and why — facts, vocabulary, tenancy, and erasure —
for anyone writing to or reasoning about the graph.

Brain stores **bitemporal facts** about entities, governed by a
declarative **predicate vocabulary**. Tenancy is physical-isolation;
PII gating runs at the JS read layer (every read surface, e2e-enforced).
GDPR forgets cascade synchronously.

## Bitemporal facts

Every fact carries two time axes:

- `validFrom` / `validUntil` — when the fact was true in the **real
  world**.
- `recordedAt` / `retractedAt` — when **brain knew** about it.

**Default search = "actual now"** (Datomic / Zep convention). Without
`asOf`, brain returns only currently-true facts:
`validFrom <= now < validUntil`, status not superseded/compacted, not
retracted. Audit / historical access through `asOf=<date>` or
`includeStale: true`. Conflict resolver uses Allen's interval
algebra — sequential validity intervals don't compete.

Full semantics: [bitemporal-semantics.md](bitemporal-semantics.md).

## Predicate vocabulary

Brain governs how facts are merged via per-predicate policies
(semantics, decay half-life, PII class). The live vocabulary is each
tenant's **predicate registry** (`knowledge_predicate`, managed via
`/v1/admin/predicates`), seeded from the core set plus any installed
[Domain Packs](domain-packs.md); the core set and the
conflict-resolution algorithm are declared in the spec at
`inite-ecosystem/core/capabilities/knowledge.yaml`.

Quick reference (core predicates):

| Predicate | Semantics | Decay half-life | PII class |
|---|---|---|---|
| `said` | append_only | 30d | text |
| `name` / `email` / `phone` | single_active | never | identifier |
| `status` | bitemporal | 7d | none |
| `intent` | bitemporal | 60d | behavioral |
| `address` | bitemporal | 90d | sensitive (`brain:read_pii` required) |
| `dob` | single_active | never | sensitive (`brain:read_pii` required) |

## Conflict resolution

```
score = 0.30·confidence + 0.40·source_trust + 0.20·recency + 0.10·authority
```

A new fact wins over the best contradicting fact only if it beats it
by ≥ 0.15. Below 0.30, ingest is rejected to a dead-letter table.
Margins between produce `COMPETING` status — both stay active, an
event is emitted for human resolution.

## Tenancy + data isolation

Each company gets its own SurrealDB database `co_<companyId>` inside
the shared `inite` namespace. Cross-tenant queries are physically
impossible at the storage layer — there is no shared table with row-
level security. Forgetting a tenant is `REMOVE DATABASE` (single
statement). Migrations apply per tenant on first request via
`ensureSchema` (idempotent).

A separate `system` database holds global state — `leader_lease`,
`api_key_revocation`, anything cross-tenant.

## PII + GDPR

- Raw message content is **not** persisted. Brain stores AI-derived
  insights and a reference back to the source vertical (e.g.,
  `{ vertical: "inbox", messageId: "..." }`).
- Hard-forget is synchronous: `POST /v1/entities/:id/forget`
  cascades through facts, edges, and embeddings, leaving only an
  HMAC-hash tombstone in `forgotten_entity`.
- Sensitive predicates are gated by `brain:read_pii` scope — they
  never appear in MCP results to AI agents without it. The gate is
  enforced in the app layer on every read surface (the DB-level
  PERMISSIONS fence exists but is inert for the pooled system user —
  see [ABAC § DB-level fence status](abac.md#db-level-fence-status-migration-0057)).

### `FORGET_HMAC_KEY`

The HMAC key used to hash entity ids in `forgotten_entity` tombstones
**must be set in production**. The default value lets anyone forge
tombstone hashes. Boot-time validation hard-fails the service in
`NODE_ENV=production` when the key is missing — see [Operations § Boot-time validation](operations.md#boot-time-validation).

## Audit trail

Retracts and forgets never delete history at the storage level — they
flip status flags. The `audit_event` table records every
`create`/`update`/`delete`/`define` operation per tenant (migration
0023). Operators read it through `GET /v1/admin/audit`; admin UI has a
filterable page with per-source / per-op rollups.

## See also

- [Bitemporal semantics](bitemporal-semantics.md) — the two clocks in depth.
- [Source reputation & trust](source-reputation.md) — the trust snapshot stamped on every fact.
- [Domain Packs](domain-packs.md) — extending the predicate vocabulary.
- [ABAC access policies](abac.md) — narrowing what individual keys read.
