# brain.inite.ai — deployment runbook

How the production instance is built, shipped, rolled back, and
observed — for whoever operates the deploy pipeline.

Production target: `brain.inite.ai`
Docker host: `inite-temporal` droplet (SFO), self-hosted GitHub runner `[self-hosted, sfo]`
Reverse proxy: Traefik global, automatic Let's Encrypt
Workflow: `.github/workflows/deploy-brain.yml` (manual dispatch)

## Stack

```
                 traefik (global)
                       │
                       ▼ Host(brain.inite.ai)
              inite-brain-service:3000   ← this repo
                       │
                       ▼ ws
              inite-surrealdb:8000       ← shared with gateway / orchestrator
                       │
                       └── NS=inite, DBs=co_<companyId>
                                  ↑ per-tenant; brain creates each on first request via ensureSchema
                                  ↑ knowledge_* tables are brain-owned and don't collide with gateway's tables in the same NS
                       
                       │ JWT
                       ▼
              auth.inite.ai/.well-known/jwks.json (audience=brain)
```

The shared `inite-surrealdb` is **the** decision point — chosen for ops
simplicity over hard isolation. Brain shares the `inite` namespace with the
gateway but owns its per-tenant `co_<companyId>` databases and the
`knowledge_*` tables, so the two never collide data-wise. CPU/IO is shared.
Watch for hot-tenant contention if either side starts running heavy graph
queries.

Brain holds an **internal SQL connection pool** (root + scoped). The DB-
level PII fence (migration `0005_pii_permissions.surql`) creates the
`brain_caller` editor user that the scoped pool signs in as. First
ensureSchema run on a fresh `co_<companyId>` boots that user before
any caller-facing read.

## One-time GitHub secrets (repo: inite-brain-service)

The workflow already references these — wire them once before the first
deploy:

| Secret | Where it goes | Notes |
|---|---|---|
| `DOCKERHUB_USERNAME` | docker login | shared with other inite services |
| `DOCKERHUB_TOKEN` | docker login | — |
| `INITE_SHARED_PAT` | `ci.yml` second checkout | optional — CI workflow only, not read by `deploy-brain.yml`; falls back to `github.token` if same-org |
| `BRAIN_SURREAL_USER` | brain SURREALDB_USERNAME | root user for the shared inite-surrealdb |
| `BRAIN_SURREAL_PASS` | brain SURREALDB_PASSWORD | — |
| `BRAIN_SURREAL_SCOPED_PASS` | brain SURREALDB_SCOPED_PASS | password for `brain_caller` user. Brain auto-overwrites the placeholder password from migration 0005 with this secret on each ensureSchema cycle. |
| `BRAIN_OPENAI_API_KEY` | OPENAI_API_KEY | embeddings + extraction + faithfulness verifier |
| `BRAIN_FORGET_HMAC_KEY` | FORGET_HMAC_KEY | ≥32 chars; used to mint opaque tombstone markers on GDPR forget |
| `BRAIN_EVIDENCE_URL_SECRET` | EVIDENCE_SIGNED_URL_SECRET (via the enablement env file) | ≥32 chars; signs evidence raw-serving URLs |
| `BRAIN_BILLING_API_KEY` | BILLING_SERVICE_API_KEY | marketplace billing client credential |

Optional feature env vars **not currently wired in `deploy-brain.yml`** —
setting these as repo secrets alone is inert; to enable one, add the
secret AND the corresponding env line to the workflow's compose /
enablement blocks (env-var semantics in [operations.md](operations.md)):

- `AUTH_SERVICE_INTROSPECTION_CLIENT_ID/SECRET` — auth-service `ik_…` API-key resolution (RFC 7662). Provision the `brain-service` client with `register-brain-clients` in the auth repo first.
- `AUTH_SSF_POLL_URL` — CAEP revocation stream (create a poll stream in the auth admin → Shared Signals); revoked IdP sessions then die within the poll interval instead of at token expiry.
- `THROTTLE_TIER_MULTIPLIERS` — per-plan rate-limit multipliers, e.g. `{"plan:pro":2}`.
- `COHERE_API_KEY` — cross-encoder reranker.
- `BRAIN_API_KEYS` — static `[{keyHash, companyId, scopes}]` JSON; only if you need a non-JWT fallback path. NODE_ENV=production + a remote verifier (JWKS/introspection) rejects static keys, so leaving this empty is correct.

## DNS

Add A-record `brain.inite.ai → <droplet IP>`. Traefik picks up the
container's labels and provisions a Let's Encrypt cert on first request.
Cert provisioning typically takes ~30s; the workflow's health probe
retries for 2 minutes.

## First deploy

1. Wire the secrets above in **Settings → Secrets and variables → Actions**.
2. Confirm `inite-surrealdb` is reachable from the droplet's docker network
   (it lives in the temporal stack — should already be `traefik-global` +
   `default`).
3. Run **Actions → Deploy brain.inite.ai → Run workflow** with `action=deploy`.
4. Workflow flow:
   - Builds the docker image, pushes to `dockerhub/inite-brain-service:<sha>` and `:latest`.
   - On the droplet: writes `/opt/projects/inite-brain-service/docker-compose.yml`,
     pulls the new image, `docker-compose up -d`.
   - Waits 25s for the container, then probes `https://brain.inite.ai/health`
     with retries (cert provisioning).
5. First request to any tenant triggers `ensureSchema` — every numbered
   migration in `src/db/migrations/` (0001 through the current head) applies
   on the per-tenant `co_<companyId>` DB, including 0005 (PII PERMISSIONS +
   `brain_caller` user). No separate migration step needed; concurrent
   appliers racing the ledger insert are tolerated.

## Subsequent deploys

**Auto-deploy on push to main.** Every merge into `main` triggers the
workflow on the sfo runner — build, push, deploy. Concurrency group
cancels in-flight auto-deploys when a newer push lands so the droplet
only runs the head commit. Doc-only / test-only / planning-only
changes skip the deploy via `paths-ignore`.

`Run workflow → action=deploy` does the same thing manually (e.g. to
deploy from a non-main branch via the dispatch UI). The container
restart is **not zero-downtime** — single replica today; brain in-flight
requests get aborted on swap. Acceptable for current traffic; revisit
when caller volume warrants.

## Where the container's env comes from

The running container reads its environment from TWO places, both
written by the deploy workflow on every deploy:

- the `environment:` block of the generated
  `/opt/projects/inite-brain-service/docker-compose.yml` — secrets,
  infrastructure settings, and a few pinned overrides;
- `/opt/projects/inite-brain-service/enablement.env`, written by the
  workflow's **"Write enablement env file"** step and referenced from
  the compose file via `env_file:` — the full feature-flag enablement
  block.

Compose precedence: on a key collision `environment:` **wins** over
`env_file`, so a pinned value in the compose block overrides the
enablement file. The flag block lives in a separate file because
embedding ~190 flag lines in the compose heredoc pushed the workflow's
run script past GitHub's **21k max-expression-length limit** — a
failure mode worth knowing: the run then fails with **zero jobs** and
only a "workflow file issue" annotation, no logs at all. If a deploy
run shows no jobs, suspect run-script size before anything else.

## Operational dispatch actions

The workflow accepts three actions via `workflow_dispatch.inputs.action`:

- `deploy` (default) — full build + push + deploy.
- `restart` — skip build, restart the running container against the same
  image. Use for env-var rotations after editing `docker-compose.yml` or
  `enablement.env` on the droplet (rare — normal env changes go through
  the workflow, which rewrites both files).
- `logs` — print last 200 lines of the container log
  (`gh workflow run deploy-brain.yml -f action=logs`). Faster than SSH.

## Health check

Internal: `wget -qO- http://localhost:3000/health` (configured in the
container healthcheck — Docker marks unhealthy after 5 failures × 15s).

External: `https://brain.inite.ai/health` returns brain's standard
HealthController shape. The `Health probe` step in the workflow polls
this for 2 minutes after `up -d`.

## Rollback

```bash
ssh root@<droplet>
cd /opt/projects/inite-brain-service
docker pull dockerhub/inite-brain-service:<previous-sha>
docker tag dockerhub/inite-brain-service:<previous-sha> dockerhub/inite-brain-service:latest
docker-compose up -d --force-recreate inite-brain-service
```

The `:latest` tag is what the docker-compose pulls; pinning a previous
sha as `:latest` rolls back without changing the workflow file. Or
re-run the workflow on a previous commit.

## Observability

The self-hosted monitoring stack (VictoriaMetrics + Loki + Tempo +
Alloy + Grafana) runs as its own compose project on the same droplet —
see [`monitoring/README.md`](../monitoring/README.md) and
`deploy-monitoring.yml`. Grafana lives at
**https://brain.inite.ai/grafana** (admin password in the
`GRAFANA_ADMIN_PASSWORD` repo secret).

- **Metrics**: Alloy scrapes `http://inite-brain-service:3000/metrics`
  every 15s over the shared docker network and remote-writes into
  VictoriaMetrics (30d). `/metrics` is intentionally NOT in the public
  Traefik rule — requests to `brain.inite.ai/metrics` fall through to
  the landing catch-all. Keep it that way: the endpoint is
  unauthenticated by design and leaks volumes/token-spend if exposed.
- **Traces**: `OTEL_ENABLED=1` + `OTEL_EXPORTER_OTLP_ENDPOINT=
  http://inite-monitoring-alloy:4318` (base URL; the exporter appends
  `/v1/traces`). Alloy forwards to Tempo (7d). Per-leg search spans,
  gen_ai.* semconv spans and jobs.enqueue/process spans land there —
  browse via Grafana Explore → Tempo.
- **Logs**: Alloy tails the docker json logs of allowlisted containers
  into Loki (14d) — query `{container="inite-brain-service"} | json`
  in Grafana Explore.
- **Alerts**: provisioned Grafana rules (scrape down, no worker
  leader, policy resolution errors, job failure ratio, disk/mem low…);
  Telegram notifications activate when the `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID` secrets are set.

## Surface-level invariants the deploy depends on

- `inite-surrealdb` container is alive and joined to the docker network
  the brain container will be on. The temporal-stack workflow brings it
  up; if it's down, `pnpm test:eval` against prod won't even reach
  brain's health endpoint because brain crash-loops on missing DB.
- `auth.inite.ai` JWKS endpoint is reachable from the droplet. The
  ApiKeyGuard refuses to start in NODE_ENV=production without a valid
  JWKS load (defense-in-depth).
- `AUTH_SERVICE_ISSUER` equals the auth-service's REAL `iss` claim —
  **`https://auth-api.inite.ai`**, NOT `https://auth.inite.ai` (the
  host the JWKS document is fetched from). A mismatch rejects EVERY
  JWKS-verified token as "Invalid credentials" while everything else
  looks healthy. Diagnose with
  `gh workflow run deploy-brain.yml -f action=logs`, then grep the
  output for `[JwksService]`: the boot line prints `issuer=…` and each
  rejection logs `JWT verification failed: …`.
- Flipping `PRIVACY_SEGMENT_USER_FENCE` on a deployment with existing
  data follows the order **migrate → backfill → flip**: deploy (0117
  applies lazily per tenant), then run
  `POST /v1/admin/maintenance/segments/backfill-user-ids` per tenant
  (`brain:admin`; body `{ tenant, maxRows? }`), then enable the flag.
  Scenes are not covered by the backfill — re-run
  `POST /v1/admin/maintenance/scenes` instead. Details:
  [operations.md](operations.md) § `PRIVACY_*`.
- Migration `0005_pii_permissions.surql` defines `brain_caller` with a
  static placeholder password (DDL doesn't bind to runtime variables).
  Right after the migration lands, brain runs
  `DEFINE USER OVERWRITE brain_caller PASSWORD $pass` against the root
  migrator connection using `SURREALDB_SCOPED_PASS`. If the secret is
  missing, the scoped pool gracefully degrades to root signin (defense-
  in-depth becomes app-only — DB-level fence not enforced). On password
  rotation: re-deploy. Brain's `ensureSchema` re-syncs the password
  once per process boot for any tenant DB that already has 0005 applied.

## See also

- [Operations](operations.md) — every env var the compose file sets.
- [Operator playbook](operator-playbook.md) — day-2 troubleshooting once deployed.
- [`monitoring/README.md`](../monitoring/README.md) — the observability stack in depth.
