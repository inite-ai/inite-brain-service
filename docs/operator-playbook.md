# Operator playbook — INITE Brain Service

The day-2 manual for the people who keep brain running — issue keys,
troubleshoot, run maintenance, recover. If you're trying to wire a
vertical *into* brain, see [migration-guide.md](migration-guide.md) instead;
for enablement runbooks of dark-shipped features (document pipeline, MCP
pack tools, billing), see [operations.md](operations.md).

## Contents

1. [Issue an ApiKey](#issue-an-apikey)
2. [Promote a tenant from dev to prod auth](#promote-a-tenant-from-dev-to-prod-auth)
3. [Troubleshoot: ingest is failing](#troubleshoot-ingest-is-failing)
4. [Troubleshoot: search returns nothing](#troubleshoot-search-returns-nothing)
5. [Run a forget (GDPR)](#run-a-forget-gdpr)
6. [Monitor: metrics + logs](#monitor-metrics--logs)
7. [Tune `SEARCH_RERANK_SKIP_MARGIN`](#tune-search_rerank_skip_margin)
8. [Run dreams off-cycle](#run-dreams-off-cycle)
9. [Enable dreams in production (staged checklist)](#enable-dreams-in-production-staged-checklist)
10. [Run compaction off-cycle](#run-compaction-off-cycle)
11. [Drain a stuck job queue](#drain-a-stuck-job-queue)
12. [Rollback queue mode (kill switch)](#rollback-queue-mode-kill-switch)
13. [Run the memory-lifecycle eval](#run-the-memory-lifecycle-eval)
14. [Restore from event replay](#restore-from-event-replay)

---

## Issue an ApiKey

In dev / staging, brain reads keys from `BRAIN_API_KEYS` (JSON array). Generate a plaintext key, hash it, add the entry, restart the service.

```bash
# Generate a 32-byte plaintext key
PLAINTEXT=$(openssl rand -hex 32)
HASH="sha256:$(echo -n "$PLAINTEXT" | shasum -a 256 | cut -d' ' -f1)"

# Add to .env (or your secret manager) — keyHash + companyId + scopes
cat <<JSON
[{"keyHash":"$HASH","companyId":"co_acme","scopes":["brain:read","brain:write"]}]
JSON
```

Hand the **plaintext** to the vertical operator over a secure channel. Brain only stores the hash.

In prod, the static map is disabled (NODE_ENV=production + any remote verifier configured). Two auth-service credential kinds replace it:

- **JWTs** (user or M2M tokens) — verified locally via JWKS.
- **Long-lived `ik_…` API keys** — issued in the auth-service admin panel (API Keys tab, audience `brain`) and resolved by brain through RFC 7662 introspection (`AUTH_SERVICE_INTROSPECTION_CLIENT_ID/SECRET`). Revocation in the panel takes effect within the introspection cache TTL (≤60 s).

## Per-agent rights and policies

Three layers decide what an AI agent may do and see; they compose (most
restrictive wins):

1. **Scopes** — coarse (`brain:read` reads everything the tenant has).
2. **RFC 9396 grants (consent-time)** — the token's
   `authorization_details` entry of type `inite_mcp_resource` lists the
   MCP actions the user approved for this agent, e.g.
   `{"type":"inite_mcp_resource","locations":["https://brain.inite.ai"],"actions":["search_knowledge","record_fact"]}`.
   Brain removes every tool outside the granted union (macro grants
   `read`/`write` allow a whole kind). Fail-closed: a grant scoped to
   another deployment yields an EMPTY tool surface. Requires
   `RAR_ENABLED` in the auth-service; set `BRAIN_PUBLIC_URL` here when
   grants carry `locations`.
3. **ABAC policies (answer-time)** — row/action rules. Delivery
   channels: `policy` claim (auth-service per-client customClaims or
   ApiKey policyNames), `policy_binding` subjects `key:<hash>`,
   `jwt:<sub>`, and `agent:<client_id>` — the last one pins sets to the
   ACTING client regardless of credential.

Every fact written through an agent carries the verified agent identity:
`source.recorder = mcp_agent:<client_id>` (MCP write tools) and
`source.meta.actor` (all ingest paths) — usable in ABAC `source.meta.*`
rules, trust review, and audits.

### Enable ABAC safely (report_only → enforce)

1. Create a policy set in the admin UI (mode `report_only`).
2. Attach it: auth-side (client customClaims / ApiKey policyNames) or
   brain-side (`policy_binding`, incl. `agent:<client_id>`).
3. Set `ABAC_ENABLED=1` and watch `v1/admin/policy/decisions` — report
   rows show what WOULD be denied, nothing blocks yet.
4. Flip the set to `enforce` once the decision stream looks right.

## Promote a tenant from dev to prod auth

1. Make sure `AUTH_SERVICE_JWKS_URL` points to the prod auth-service (`https://auth.inite.ai/.well-known/jwks.json`).
2. Set `AUTH_SERVICE_ISSUER` and `AUTH_SERVICE_AUDIENCE` to the values that auth-service signs with.
3. Set `NODE_ENV=production`. The boot log should say `Static BRAIN_API_KEYS disabled in production with a remote verifier enabled`.
4. Have the vertical re-issue its credentials. Brain accepts JWTs whose `scopes` claim contains the brain scopes (`brain:read`, `brain:write`, optionally `brain:read_pii`, `brain:admin`). Tenant/user mapping: an `org` claim makes it a user-bound token (tenant = `org`, end-user = `sub`, per-user memory pinned to that user); without `org`, `sub` is the company ID (M2M).
5. Verify with a single `curl` that uses the JWT — expect `200 OK` on `GET /v1/entities/<id>` for the company's data.

## Troubleshoot: ingest is failing

Symptoms: `POST /v1/ingest/fact` returns 500, or 4xx with a validation error.

1. **Check the request log.** Each request is one line: `POST /v1/ingest/fact → <status> <ms> company=<id> key=<keyTag>`. If `key=-`, the request reached brain unauthenticated — fix the caller.
2. **`brain_ingest_facts_total{outcome="REJECTED"}`** — if this counter ticks, the conflict resolver is rejecting writes. Inspect the per-row reason in the request log (look for `outcome=REJECTED`) and check the predicate's policy in `conflict-resolver.ts`.
3. **Surreal is unreachable** — `/health` returns `db: false`. Look at the Surreal container logs (`docker logs <surreal>` or your hosting provider's equivalent). Most common: pod evicted, restart pending.
4. **Pool exhausted** — request log shows ingest calls hanging at high concurrency. Bump `SURREALDB_POOL_SIZE`. Default is 8; we've run 32 comfortably on a 4-vCPU node.
5. **Embedder errors** — `OpenAI` errors in stderr. Check `OPENAI_API_KEY` quota in the OpenAI dashboard. The `OPENAI_MAX_RETRIES` knob (default 3) governs retry behaviour.

## Troubleshoot: search returns nothing

Symptoms: `POST /v1/search` returns `{ results: [] }` for queries that obviously match.

1. **Embedding mismatch.** If you changed `OPENAI_EMBEDDING_MODEL` or `OPENAI_EMBEDDING_DIMENSIONS`, old vectors don't match new queries. Re-embed by reingesting (events) or compacting.
2. **The data was forgotten.** Check the tenant's `forgotten_entity` table — there'll be a tombstone row per cascade-forget. Ingests after a forget go to a fresh entity with a new `cuid`, so old searches won't find them.
3. **Wrong `asOf`.** A historical query with `asOf` predating the fact's `validFrom` will skip it. Drop `asOf` and retry to confirm.
4. **PII gating.** A caller without `brain:read_pii` cannot see PII facts. Search itself is unaffected (entity still ranks), but specific facts will be missing from the result. Inspect the caller's scopes via the request log's `key=` tag and your key registry.
5. **Multi-tenant fan-out gone wrong.** Search runs only inside `NS=inite DB=co_<companyId>` (in prod; `NS=brain` in dev when `SURREALDB_NAMESPACE=brain`). If the caller is on the wrong companyId, they're looking in the wrong DB. Confirm `req.brainAuth.companyId` matches the data's expected tenant.

## Run a forget (GDPR)

A `POST /v1/entities/:id/forget` cascades the deletion of every fact, edge, and link tied to the entity, and writes a tombstone in `forgotten_entity`. The tombstone keeps an HMAC of the entity ID + the request ID + counts. No plaintext entity ID is retained.

```bash
curl -X POST https://brain.example.com/v1/entities/$ENTITY_ID/forget \
  -H "authorization: Bearer $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"reason":"gdpr_request","requestId":"GDPR-2026-04-12"}'
```

`reason` is one of `gdpr_request`, `tenant_offboarding`, `operator_request`. The HMAC means you can prove a forget happened without recovering what you forgot.

For a whole-tenant forget, hit `dropCompanyDatabase` directly (admin tooling, not exposed via HTTP). That's a single-statement `REMOVE DATABASE co_<companyId>`.

## Monitor: metrics + logs

`GET /metrics` exposes a Prometheus text payload:

- `brain_ingest_facts_total{outcome}` — INSERTED / SUPERSEDED / COMPETING / REJECTED
- `brain_ingest_mentions_total{result}` — extracted / skipped / failed
- `brain_search_duration_seconds` — histogram, p50/p99 alarms recommended
- `brain_search_rerank_total{outcome}` — invoked / skipped_disabled / skipped_singleton / skipped_margin. The `skipped_margin` line tracks how often the LLM rerank was bypassed because the post-fusion top-1 vs top-2 gap was already wide; ratio against `invoked` is the cost-saving you got from `SEARCH_RERANK_SKIP_MARGIN`.
- `brain_search_cross_encoder_total{outcome}` — invoked / error / skipped_disabled / skipped_singleton. `error` rate above ~1% means Cohere is timing out or 4xx-ing — bump `SEARCH_CROSS_ENCODER_TIMEOUT_MS`, check the Cohere status page, or rotate `COHERE_API_KEY`.
- `brain_multi_hop_total{outcome}` — ok / single_hop / chain_empty / no_results / planner_error / hop_error. `single_hop` dominating means most queries are one-step (planner correctly skipping decomposition); `chain_empty` is normal — chains often disprove themselves on hop 2. Spike in `planner_error` ⇒ OpenAI is flaky; spike in `hop_error` ⇒ the search backend (Surreal) is unhappy.
- `brain_synthesize_total{outcome}` — ok / no_results / no_grounded_evidence / verifier_partial / verifier_failed / generator_error / verifier_error. The healthy mix is `ok` dominant + a few `no_grounded_evidence` (the model honestly refused). High `verifier_failed` rate means generator is hallucinating or context window is too narrow — investigate `SEARCH_*` knobs upstream. High `*_error` means OpenAI is flaky — check `brain_openai_calls_total{outcome="error"}` for confirmation.
- `brain_retract_total`, `brain_forget_total` — usage counters
- `brain_compaction_facts_total` — sums across tenants
- `brain_process_*`, `brain_nodejs_*` — node defaults (heap, event-loop lag)

The endpoint is **unauthenticated by design** — firewall it off the public surface (only your prom-scraper subnet should reach `/metrics`).

Logs come in two formats. Default in dev: human single-line. Default in prod (`NODE_ENV=production`) or when `LOG_FORMAT=json`: one JSON object per line, ready for Loki/CloudWatch/Datadog.

Each request line carries `companyId` and a short `keyTag` (first 8 chars of `keyHash` after the `sha256:` prefix). Use `keyTag` to attribute traffic to a specific issued key without recovering the secret.

## Tune `SEARCH_RERANK_SKIP_MARGIN`

A relative-margin gate that bypasses the LLM reranker when the fused top-1 has a clear lead over top-2. Default `0` (off). Recommended starting value `0.5` once you have 1-2 weeks of `brain_search_rerank_total{outcome}` data.

Procedure:

1. Leave at `0` for 7 days, gather `invoked` baseline.
2. Set `SEARCH_RERANK_SKIP_MARGIN=0.5`. The metric series will split into `invoked` and `skipped_margin`. Aim for `skipped_margin / (invoked + skipped_margin)` ≈ 0.3–0.5; that's where the cost saving usually lives without losing recall.
3. Spot-check by running `pnpm test:eval` against a tenant snapshot, comparing the with-margin vs no-margin recall@1 / MRR. If recall drops more than 1pp, lower the threshold.
4. Bump down to `0.3` for stricter saving, up to `0.7` if recall regressed; never go above `0.9` (you'd skip almost every query, defeating the reranker's purpose).

The reranker stays the canonical quality lever — this knob just trades a small precision risk for a large cost reduction on queries that didn't need it anyway.

## Run dreams off-cycle

Dreams is the daily self-improvement pass — auto-dedup (cosine + LLM judge), auto-resolve aged competing pairs (LLM judge), optional LLM-backed compaction summaries. Default cron is 04:00 UTC; force-run for one tenant via the admin endpoint:

```bash
curl -X POST https://brain.example.com/v1/dreams/run \
  -H "authorization: Bearer $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{ "operations": ["dedup", "resolve", "summarize"] }'
```

Watch for:
- `brain_dreams_total{outcome="failed"}` — sub-service threw on a tenant. Check logs for the per-tenant error message.
- `brain_dreams_emitted_total{kind="identity_link"}` rising spike — usually means a recent batch ingest created near-duplicate entities. Healthy signal *if* it's a one-off; recurring spike means upstream extraction is fragmenting identities and needs investigation upstream of brain.
- `brain_dreams_emitted_total{kind="resolution"}` rising — competing-fact backlog being chewed. Watch the unsure rate (logged at WARN level) — high unsure means the LLM can't actually disambiguate and the operator should clear the backlog manually.

When NOT to enable dreams:
- Tenants with very few entities (< ~50). The dedup cosine kNN doesn't have enough neighbours to be useful and you pay the LLM judge cost on basically every pair.
- Workloads where competing facts are intentional (e.g. multi-source CRM where two sources disagree by design until human reconciliation). Run dedup but not resolve.

## Enable dreams in production (staged checklist)

Every hygiene loop ships dark (`DREAMS_ENABLED=0`, `DREAMS_DEDUP_ENABLED=0`, `DREAMS_RESOLVE_ENABLED=0`, `COMPACTION_SUMMARIES=false`) — a default deploy does no entity dedup, no competing-fact auto-resolution, no summary rollups. Turn them on one stage at a time, roughly a week apart, and let the metrics tell you when the previous stage is trustworthy.

**Prerequisites (all stages):**

- Migration **0052** applied — dreams-resolve writes `retractedBy='dreams'`, which the pre-0052 field ASSERT rejects. Without it stage 2 fails on its first resolution.
- The memory-quality gauges are on your dashboard (`brain_memory_facts{status="competing"}`, `brain_memory_stale_active_facts`) — they are the before/after evidence for each stage.
- Nightly quality eval green for the trailing week (`quality-eval` CI job) so a hygiene regression is attributable.

**Stage 1 — dedup (`DREAMS_ENABLED=1`, `DREAMS_DEDUP_ENABLED=1`):**

- Defaults are conservative (`DREAMS_DEDUP_MAX_PAIRS=50`, cosine ≥0.92, LLM judge). Merges are reversible `identity_of` edges — spot-check a few via `find_related_entities` before trusting the loop.
- Watch `brain_dreams_emitted_total{kind="identity_link"}`: a one-off spike after a batch ingest is healthy; a recurring spike means upstream extraction fragments identities.

**Stage 2 — resolve (`DREAMS_RESOLVE_ENABLED=1`), after ≥1 clean week of stage 1:**

- Keep `DREAMS_RESOLVE_MIN_AGE_DAYS=7` and `DREAMS_RESOLVE_MAX_PAIRS=20` — the loop only adjudicates exactly-2-way pairs and defaults to "unsure", so cost and blast radius stay bounded.
- Success signal: `brain_memory_facts{status="competing"}` trends down while the WARN-level unsure rate stays low. High unsure = the LLM can't disambiguate your domain; clear the backlog manually (`get_competing_facts` + `retract_fact`) instead of raising the caps.

**Stage 2b — fuzzy corroboration (`DREAMS_CORROBORATE_ENABLED=1`), optional, alongside or after stage 2:**

- Finds the same claim worded differently across origins and folds it into the incumbent's corroboration counter (`brain_dreams_emitted_total{kind="corroboration"}`). Bounded by `DREAMS_CORROBORATE_MAX_PAIRS` (20); only `bitemporal`-semantics predicates are eligible, so event history (`said`, `complained_about`) is never collapsed.
- Spot-check the first runs via the `dream_emit` drill-down (kind=`corroboration`) — the younger row should be a genuine re-wording, not a contradiction.

**Stage 3 — summaries (`COMPACTION_SUMMARIES=true`, optionally `DREAMS_LLM_SUMMARY_ENABLED=1`):**

- Only after stages 1–2 are boring. The default generator is concat; the LLM generator falls back to concat on any error, so flipping `DREAMS_LLM_SUMMARY_ENABLED` is safe.

**Rollback:** set the flags back to `0` — the loops simply stop at the next cron; nothing to migrate back. Already-applied resolutions are auditable (`retractedBy='dreams'`, `conflictTrace`) and individually reversible: retracting the winner revives the superseded fact with its prior interval.

## Run compaction off-cycle

The cron runs daily at 03:17 UTC. **Under default queue mode** (`JOBS_QUEUE_MODE=enqueue`), the cron enqueues one `compaction` job per tenant — the worker loop on the leader pod claims and dispatches. To force a run for one tenant from an admin caller:

```bash
# Enqueue a compaction job (manual trigger via the maintenance endpoint —
# adds a brain:admin entry to /v1/admin/jobs that the worker loop drains).
# Phase J/K shipped this as an async/202 endpoint set; the older sync
# "POST /v1/dreams/run" pattern still works for dreams.
curl -X POST https://brain.example.com/v1/admin/maintenance/dreams/run \
  -H "authorization: Bearer $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{ "operations": ["summarize"] }'   # the summarize op delegates to CompactionService

# Or, for a direct one-off bypassing the queue (legacy script path):
# - Set JOBS_QUEUE_MODE=inline before restart
# - Use the synchronous /v1/dreams/run (returns full stats inline)
```

If you don't see the cron tick (`[CompactionService] Compaction starting…` at 03:17 UTC under `JOBS_QUEUE_MODE=inline`, or a `compaction` row appearing in `/v1/admin/jobs` at the same time under `enqueue`), check:
- `ScheduleModule` is imported by `CompactionModule`
- the process actually survives until 03:17 (no nightly restart)
- in queue mode: the leader pod's `worker_loop` lease is held (`GET /v1/admin/leases`)
- the `compaction` handler is registered (`workerLoop.registeredTypes` in the leases response)

## Drain a stuck job queue

Symptom: `/v1/admin/jobs?status=pending` returns rows that aren't transitioning to `running`. The queue is backing up.

Diagnostic sequence:

1. **Check the leader cockpit.** `GET /v1/admin/leases` shows:
   - `workerLoop.leader` — is THIS pod the worker? On single-pod prod it must be `true`.
   - `leaderLeases[].name='worker_loop'` — who holds the lease? `expired: true` means everyone lost it, the next aspirant should pick it up within `WORKER_LOOP_LEASE_RENEW_MS` (30s default).
   - `workerLoop.registeredTypes` — is the jobType your stuck rows are using actually registered? A typo or a module that didn't run `onModuleInit` shows up as missing here.
   - `activeClaims[].lastHeartbeatSecondsAgo` — if any are >30s, the worker is wedged.

2. **Stale claims.** If `activeClaims[]` includes a row with `leaseExpired: true`, the `LeaseManagerService` reaper should pick it up within 10s (the cron cadence). If it doesn't, the reaper isn't running — check `leaderLeases[].name='lease_manager_cron'`.

3. **Pending pile-up despite a healthy leader.** Means the handler is too slow OR the empty-backoff is throttling. Tune:
   - `WORKER_LOOP_POLL_MS` (lower → faster pickup, more Surreal load)
   - `WORKER_LOOP_EMPTY_BACKOFF_MS` (only kicks when ALL tenants drained — if one tenant is hot the backoff doesn't apply)

4. **Manual rescue.** A truly stuck row can be flipped back to pending via Surreal:
   ```sql
   USE NS inite DB co_<companyId>;
   UPDATE job_run SET status = 'pending', claimedBy = NONE, leaseUntil = NONE,
                       visibleAfter = time::now()
     WHERE runId = $stuckRunId;
   ```
   The next claim cycle will pick it up. Don't do this if the handler might still be in flight on another pod — race risk.

## Rollback queue mode (kill switch)

If queue mode is misbehaving and you need to fall back to pre-Phase-J inline execution NOW:

1. SSH to the droplet (`/opt/projects/inite-brain-service`).
2. Edit `docker-compose.yml` — change `JOBS_QUEUE_MODE=enqueue` to `JOBS_QUEUE_MODE=inline`.
3. `docker-compose up -d --force-recreate inite-brain-service`.
4. Verify: next cron tick at 03:17 / 04:00 / 03:42 / 03:51 UTC should log `[CompactionService] Compaction starting — N tenant(s)` etc. NO `enqueued` log line. NO new pending rows in `job_run`.

`inline` mode bypasses `enqueue → claim → dispatch` entirely. Cron handlers run synchronously inside the `@Cron`-decorated method, gated only by `DistributedLeaseGuard.run(<key>, ...)` (same key the pre-Phase-J code used). Existing `pending` rows in `job_run` are NOT consumed — they sit until you either (a) flip back to `enqueue`, (b) manually transition them to `cancelled`, or (c) delete them.

Use this as a last-resort. The proper fix is to find what broke queue mode (usually: a handler crashed during registration; the leader pod is unhealthy; Surreal SSI is rejecting too many transactions) and address it.

## Run the memory-lifecycle eval

`pnpm test:eval` covers retrieval AND memory-lifecycle assertions across the full scenario suite. The lifecycle slice (`memlc.*` scenario ids) validates four invariants:

1. **Update / supersede** — newer fact replaces older; default search returns the new object only. `memlc.update.tier-upgrade`, `memlc.supersede-chain.tier-trajectory`.
2. **Retract** — retracted fact does NOT surface in default search; `includeRetracted=true` with the right `asOf` still finds it (audit trail intact). `memlc.retract.complaint-walk-back`.
3. **Forget** — GDPR cascade removes every angle of the entity from default search (name, email, complaint, interaction). `memlc.forget.gdpr-cascade`.
4. **Update + retract cycle** — operator records a wrong fact on top of the right one, then retracts the wrong fact. The original truth remains in default search. `memlc.cycle.update-then-retract`.

The aggregator surfaces `memory-lifecycle-correctness` (fraction of memory-lifecycle assertions passed). The threshold is **1.0** — anything less means brain's read side disagrees with the write semantics, which is non-negotiable. A failing assertion appears in the report's "Memory-lifecycle FAILURES" section with scenario id, kind, and detail.

For scale validation, run `pnpm test:eval:directory`. The jumbo fixture seeds ~1k customers with realistic distributions:
- 30% temporal tier trajectories (3-fact supersede chain over 3 months)
- 5% competing status (active vs churned, near-identical confidence)
- 3% retracted complaints
- 1% GDPR-forgotten customers (full cascade — name, email, complaints, payment events)

Memory assertions probe a bounded slice (first 10 entries) of each lifecycle bucket so the runtime stays under the timeout cap. Tunable via `BRAIN_DIRECTORY_*` env vars (see `test/directory.real-e2e-spec.ts` head comment).

## Restore from event replay

Brain is a **system of insight**. If the storage layer is wiped, restore by replaying the upstream events:

1. Identify the affected tenants (`co_*` under your configured `SURREALDB_NAMESPACE`, `NS=inite` in prod). For each, the `recordedAt` of the most recent fact is the time-of-loss.
2. Pull events from upstream (`inbox.message.received`, `billing.payment.*`, etc.) since that timestamp.
3. Re-publish them into brain's normal ingest path. The conflict resolver will deduplicate against any survivors.

Replay produces the same state modulo timestamps and CUIDs. If your downstream consumers depend on stable IDs, restore from a snapshot instead — the SurrealDB native backup CLI is the right tool for that.

## See also

- [Operations](operations.md) — every env var + the staged enablement runbooks.
- [Deploy runbook](DEPLOY.md) — the production stack, rollback, observability wiring.
- [API reference](api.md) — the admin endpoints used throughout this playbook.
