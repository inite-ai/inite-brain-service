# Operator Playbook — INITE Brain Service

This is the day-2 manual for the people who keep brain running. If you're trying to wire a vertical *into* brain, see `migration-guide.md` instead.

## Contents

1. [Issue an ApiKey](#issue-an-apikey)
2. [Promote a tenant from dev to prod auth](#promote-a-tenant-from-dev-to-prod-auth)
3. [Troubleshoot: ingest is failing](#troubleshoot-ingest-is-failing)
4. [Troubleshoot: search returns nothing](#troubleshoot-search-returns-nothing)
5. [Run a forget (GDPR)](#run-a-forget-gdpr)
6. [Monitor: metrics + logs](#monitor-metrics--logs)
7. [Run compaction off-cycle](#run-compaction-off-cycle)
8. [Restore from event replay](#restore-from-event-replay)

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

In prod, the static map is disabled (NODE_ENV=production && AUTH_SERVICE_JWKS_URL set → JWT-only). Issue keys through `inite-auth-service` — the vertical receives a JWT signed by that service, and brain verifies it via JWKS.

## Promote a tenant from dev to prod auth

1. Make sure `AUTH_SERVICE_JWKS_URL` points to the prod auth-service (`https://auth.inite.ai/.well-known/jwks.json`).
2. Set `AUTH_SERVICE_ISSUER` and `AUTH_SERVICE_AUDIENCE` to the values that auth-service signs with.
3. Set `NODE_ENV=production`. The boot log should say `Static BRAIN_API_KEYS disabled in production with JWKS enabled — JWT only`.
4. Have the vertical re-issue its credentials. The brain accepts JWTs whose `sub` is the company ID and whose `scopes` claim contains the brain scopes (`brain:read`, `brain:write`, optionally `brain:read_pii`, `brain:admin`).
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
5. **Multi-tenant fan-out gone wrong.** Search runs only inside `NS=brain DB=co_<companyId>`. If the caller is on the wrong companyId, they're looking in the wrong DB. Confirm `req.brainAuth.companyId` matches the data's expected tenant.

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
- `brain_synthesize_total{outcome}` — ok / no_results / no_grounded_evidence / verifier_partial / verifier_failed / generator_error / verifier_error. The healthy mix is `ok` dominant + a few `no_grounded_evidence` (the model honestly refused). High `verifier_failed` rate means generator is hallucinating or context window is too narrow — investigate `SEARCH_*` knobs upstream. High `*_error` means OpenAI is flaky — check `brain_openai_calls_total{outcome="error"}` for confirmation. `error` rate above ~1% means Cohere is timing out or 4xx-ing — bump `SEARCH_CROSS_ENCODER_TIMEOUT_MS`, check the Cohere status page, or rotate `COHERE_API_KEY`.
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

## Run compaction off-cycle

The cron runs daily at 03:17 UTC. To force a run for one tenant (e.g. after a bulk import that immediately needs to age out):

```ts
// From a one-off script — see scripts/* for similar utilities
import { CompactionService } from './src/compaction/compaction.service';
const stats = await app.get(CompactionService).compactCompany('co_acme');
console.log(stats); // { companyId, factsCompacted, bytesFreed }
```

If the cron itself is missing (no `[CompactionService] Compaction starting…` log line at 03:17 UTC), check that `ScheduleModule` is imported by `CompactionModule` and that the process actually survives until 03:17 (no nightly restart).

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

1. Identify the affected tenants (`co_*` under `NS=brain`). For each, the `recordedAt` of the most recent fact is the time-of-loss.
2. Pull events from upstream (`inbox.message.received`, `billing.payment.*`, etc.) since that timestamp.
3. Re-publish them into brain's normal ingest path. The conflict resolver will deduplicate against any survivors.

Replay produces the same state modulo timestamps and CUIDs. If your downstream consumers depend on stable IDs, restore from a snapshot instead — the SurrealDB native backup CLI is the right tool for that.
