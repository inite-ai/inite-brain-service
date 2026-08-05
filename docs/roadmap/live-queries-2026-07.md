# LIVE queries (realtime push) — design & staging

Status: **design-first, not yet implemented.** This is the "infra design step"
the SurrealDB-native plan (Phase 3) mandates before any `LIVE SELECT` code lands.
It records what exists today, why the naive slice (3a) has near-zero marginal
value, and the architecture the real target (3b) needs — so the implementation
session starts from a vetted design instead of improvising persistent-connection
lifecycle in a hot codebase.

## What exists today

- **Push is already event-driven, not cron.** `IndexerWebhookService.notifyWorkAvailable`
  (`src/documents/indexer-webhook.service.ts`) fires an HMAC-signed `work_available`
  POST to a pack's `callbackUrl` **the moment ingest stages external work** — sub-second,
  best-effort, with a per-URL circuit breaker. There is no minute-cron in this path.
- **Pull is the source of truth.** `GET /v1/indexer/work`
  (`src/documents/indexer-work.controller.ts`) — indexers poll; a missed webhook costs
  latency, never work.
- **CHANGEFEED, 30d, on all three knowledge tables** (`0002`, `0004`): `knowledge_fact`,
  `knowledge_entity`, `knowledge_edge`, `INCLUDE ORIGINAL`. Drained today by the audit
  mirror poller — **the missing-events bridge a LIVE subscription needs on reconnect.**
- **No `LIVE SELECT` anywhere** (`grep .live(` → empty).
- **Connection model is pool-acquire-switch-release.** `SurrealService`
  (`src/db/surreal.service.ts`): `db.use({namespace, database})` mutates connection state,
  so a request acquires an idle pooled connection, switches it to its tenant DB, runs, and
  releases. Connections are **never held across requests**. Plus one dedicated long-lived
  root connection for the migrator (outside both pools).

## Why 3a (indexer work-push via LIVE) is NOT worth doing

The plan assumed realtime was "minute-cron polling + best-effort webhook." It isn't — the
webhook already fires immediately at work-creation time. So replacing/augmenting it with a
`LIVE SELECT` on the pending-work table buys **~0 latency** and adds real cost:

- A `LIVE SELECT` needs a **connection held open** for the subscription lifetime — impossible
  in the acquire-switch-release pool; it needs a dedicated persistent connection per tenant DB.
- **Multi-pod duplicate delivery:** if every pod subscribes, every new work row fires N
  webhooks. Avoiding that means a leader-per-tenant — infrastructure with no payoff here,
  since the ingesting pod already knows about the work it just created and pushes it directly.

**Recommendation: do not convert the indexer webhook to LIVE.** Keep immediate-webhook +
poll-fallback. (If a future need arises for a pod that *didn't* create the work to learn of
it — e.g. a separate dispatcher tier — revisit then, with the leader design below.)

## The real target: 3b — realtime fact-subscription product

Value (`docs/roadmap/mcp-and-memory.md:300`): `mcp://entity/<id>/timeline` and
`mcp://changefeed/<since>` — an agent **subscribes** to an entity/tenant and gets pushes
instead of polling. This is a genuine product surface. It needs five things the current
architecture does not have:

### 1. Persistent subscription connections (outside the pool)
A `LiveSubscriptionManager` holding long-lived connections keyed by `(tenant, liveQuery)`,
separate from `scopedPool`/`rootPool`. It must reuse the pool's hard-won liveness handling:
the **zombie-websocket** failure (`gh#618`, `surreal.service.ts:106`) where `conn.status`
stays `"connected"` after a half-open TCP drop and no reconnect fires — a persistent
subscription is *more* exposed to this than a short-lived pool conn, so the bounded-time
liveness probe + full-rebuild path is mandatory, not optional.

### 2. Reconnect + **resume** (the CHANGEFEED bridge)
A dropped/reconnected `LIVE` **misses every event during the gap** — unacceptable for a
memory product. Bridge it with the existing 30d `CHANGEFEED`: track the last-delivered
timestamp per subscription; on reconnect, `SHOW CHANGES FOR TABLE knowledge_fact SINCE <ts>`
to replay the gap, then resume live. This is the key design insight — **LIVE for push,
CHANGEFEED for catch-up** — and it's already available (no new schema). Bound replay by the
30d window; a subscriber offline longer than that gets a "resync from full read" signal.

### 3. Multi-pod fan-out (leader-per-tenant)
Client subscribers connect to Brain (SSE or WS at the API tier), not to SurrealDB. Behind
that, exactly **one** pod should hold each tenant's `LIVE` and fan out to all local
subscribers + a shared channel for subscribers on other pods. The existing coarse
leader-lease (used for cron) does **not** map: it elects one global leader, but here we need
per-tenant sharding (tenant → owning pod) so load spreads and one tenant's subscription
volume doesn't pin a single pod. Design a per-tenant lease (hash tenant → shard → lease) or
a dedicated fan-out bus. **This is the sub-project's hardest piece — do it before any code.**

### 4. ABAC / row-policy fence on the push path
`LIVE SELECT` rows arrive **raw** — they bypass the JS `makeRowPolicyFilter` every read
surface applies (`src/policy/row-filter.ts`), and the DB-level PERMISSIONS fence is known to
be partial (the "phantom-fence" finding: system users bypass PERMISSIONS). So **every event
must pass the same per-row PII/ABAC verdict as `/v1/search` before delivery**, evaluated in
the fan-out layer with the subscriber's scopes. A subscription is a standing read; it must
not become an ABAC bypass. Non-negotiable.

### 5. Backpressure + lifecycle
Per-subscription send queue with a bounded buffer (slow consumer → drop-to-resync, not
unbounded memory); idle-timeout + explicit unsubscribe; a global cap on concurrent
subscriptions per tenant and per pod.

## Staging recommendation

1. **Land this design** (this doc). ✅
2. **Do not touch the indexer webhook.**
3. When 3b is scheduled as its own session: build a **single-tenant, single-pod prototype**
   behind `LIVE_SUBSCRIPTIONS_ENABLED` (default off) — `LiveSubscriptionManager` +
   CHANGEFEED-resume + the ABAC fence on delivery — proving the resume bridge and the fence
   first. Multi-pod fan-out (#3) is a follow-on gated on the per-tenant-lease design.
4. Only then wire the MCP `mcp://…/timeline` / `mcp://changefeed/<since>` surfaces on top.

## Explicitly not doing now
- No persistent-connection code, no `.live()`, no MCP subscription surface this session —
  each depends on the resume + fence + fan-out design above, and a half-built persistent
  subscription system (connection leaks, reconnect storms, duplicate/lost delivery, ABAC
  bypass) is a production-incident shape, not a SOTA feature. Design lands; implementation is
  a dedicated, flag-gated sub-project.
