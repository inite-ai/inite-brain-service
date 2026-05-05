# Migration Guide — wiring a vertical into INITE Brain

This walks a vertical maintainer from "no brain integration" to "knowledge capability shipped" in their app. The runtime path is `inite.<vertical>` → `@inite/knowledge` SDK → brain HTTP/MCP.

## What you get

Once integrated, your vertical can:

- Search across the tenant's customers/staff/assets/etc. by natural-language query.
- Pull a unified profile for any entity (canonical name, externalRefs, fact timeline).
- Retract a fact when your domain says it's wrong.
- Cascade-forget an entity when GDPR demands it.
- Listen for `knowledge.fact.*` events to react when the brain learns something new.

You do **not** get a system of record. Brain is derived state. For transactional fields (account balance, payment status, lease end date), keep reading from your own database.

## Prerequisites

- `@inite/knowledge` ≥ 0.1.0 in your `inite-shared` dependency tree.
- Brain reachable on a stable URL (`BRAIN_BASE_URL` in your vertical's config). For dev: `http://localhost:3000`. For prod: whatever your platform team published.
- An ApiKey or JWT (see operator-playbook.md).

## Step 1 — Declare the capability in your manifest

In `inite-ecosystem/core/capabilities/<your-vertical>.yaml`:

```yaml
capabilities:
  knowledge:
    enabled: true
    # Default: every fact ingested under this tenant is searchable by
    # default-scope callers. Override with predicate.gating in
    # core/capabilities/knowledge.yaml.
    subscribed_inputs:
      - inbox.message.received
      - inbox.message.sent
      - billing.payment.captured
      - billing.payment.failed
      # Add any vertical-specific events you want brain to ingest.
      - storefront.order.created
```

The capability is `optional` (ring: `standard`). Verticals can ship without it; declaring it is opt-in.

## Step 2 — Install the SDK

```bash
pnpm add @inite/knowledge
```

In your vertical's bootstrap module:

```ts
import { BrainClient } from '@inite/knowledge';

const brain = new BrainClient({
  baseUrl: process.env.BRAIN_BASE_URL!,
  apiKey: process.env.BRAIN_API_KEY!, // plaintext key OR JWT
});
```

The same client object handles ingest, search, retract, forget, and entity reads.

## Step 3 — First test connection

```ts
const profile = await brain.entityProfile('knowledge_entity:doesnotexist');
// Expect a NotFoundException — that's the success signal: auth + routing work.
```

If you get `401 Unauthorized`, your key is wrong or the brain is in JWT-only mode and you sent a static key. If you get a Surreal error, the brain isn't reachable.

## Step 4 — Wire ingest

Most verticals don't call `ingest.fact` directly. Instead, brain subscribes to your event stream and ingests automatically. Confirm your events land:

```ts
// After your vertical emits e.g. inbox.message.received
const search = await brain.search({ query: 'recent inbound messages', limit: 5 });
// You should see facts with predicate=said + your contextRef.messageId.
```

For domain-specific structured facts (e.g. a CRM sync), call `brain.ingest.fact` directly:

```ts
await brain.ingest.fact({
  entityRef: { vertical: 'rent', id: 'cust_42' },
  predicate: 'tier',
  object: 'gold',
  validFrom: new Date().toISOString(),
  source: { vertical: 'rent', eventId: 'crm.tier.changed' },
  confidence: 0.95,
});
```

Outcomes (returned as `outcome`):

- `INSERTED` — new fact, no conflict.
- `SUPERSEDED` — replaced an older fact for the same (entity, predicate). Old fact is closed (`validUntil` set).
- `COMPETING` — equal-confidence rival exists. Both stay live; readers see both.
- `REJECTED` — confidence below threshold or policy says no. The dead-letter table records it.

## Step 5 — Search

Hybrid (vector + BM25) by default. The query is whatever a human would type:

```ts
const res = await brain.search({
  query: 'tenants who reported broken heating',
  limit: 10,
  asOf: '2026-04-01T00:00:00Z', // optional bitemporal scope
});

for (const hit of res.results) {
  console.log(hit.entityId, hit.canonicalName, hit.facts.length);
}
```

Each `hit.facts` is filtered by the caller's scopes — a `brain:read`-only key won't see PII facts even if they exist.

## Step 6 — Listen for derived events

Brain emits events when state changes. Subscribe at the same place you handle `inbox.*` etc.:

- `knowledge.fact.inserted` — new fact landed.
- `knowledge.fact.superseded` — old fact closed.
- `knowledge.fact.retracted` — operator/system retracted.
- `knowledge.fact.compacted` — fact aged into the warm tier.
- `knowledge.entity.merged` — `identity_of` cascade resolved two profiles into one.
- `knowledge.entity.forgotten` — GDPR cascade fired.

Use these to invalidate cached profiles in your UI, update audit trails, etc.

## Step 7 — Quality gate before shipping

Before announcing the integration, run the eval suite for your vertical:

```bash
cd inite-brain-service
pnpm test:eval
```

Look for your vertical in the output. Recall@1 should be ≥ 0.6 across the scenarios that touch your vertical. If it's below, the most common causes are:

1. Your event stream doesn't include enough lexical surface (e.g. you redact too much before forwarding to brain).
2. Your domain predicates are too granular and the embedding can't disambiguate. Bundle them.
3. Your `confidence` values cluster too close to 1.0 — the conflict resolver can't pick a winner. Spread them by source-trust tier.

## Common pitfalls

- **Treating brain as a write-back store.** It isn't. If your UI lets a human edit a fact, write to your DB and emit an event; brain will pick it up.
- **Skipping `validFrom`.** It's required. The conflict resolver weighs recency by `validFrom`, not `recordedAt`. Pass the real-world time the fact became true.
- **Ingesting one giant text per customer.** The mention extractor works best on conversational chunks (one message). Longer documents should be chunked at semantic boundaries.
- **Sharing one ApiKey across humans.** Issue per-operator (or per-service) keys so the request log's `keyTag` is meaningful for audit.

## Reference

- Capability spec: `core/capabilities/knowledge.yaml` (in inite-ecosystem)
- Service contract: `core/services/brain.yaml` (in inite-ecosystem)
- ADR: `docs/adr/0001-knowledge-system-of-insight.md`
- SDK source: `packages/knowledge/` (in inite-shared)
- Service source: `inite-brain-service/`
