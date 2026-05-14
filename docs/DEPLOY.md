# brain.inite.ai — deployment runbook

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
                       └── NS=brain, DBs=co_<companyId>
                       │
                       └── (other namespaces owned by gateway, etc — isolated)
                       
                       │ JWT
                       ▼
              auth.inite.ai/.well-known/jwks.json (audience=brain)
```

The shared `inite-surrealdb` is **the** decision point — chosen for ops
simplicity over hard isolation. Brain's namespace `brain` is fully isolated
data-wise from gateway's `inite`. CPU/IO is shared. Watch for hot-tenant
contention if either side starts running heavy graph queries.

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
| `INITE_SHARED_PAT` | second checkout | optional — falls back to `github.token` if same-org |
| `GATEWAY_SURREAL_USER` | brain SURREALDB_USERNAME | reuses gateway's root creds (same SurrealDB instance) |
| `GATEWAY_SURREAL_PASS` | brain SURREALDB_PASSWORD | — |
| `BRAIN_SURREAL_SCOPED_PASS` | brain SURREALDB_SCOPED_PASS | password for `brain_caller` user. Brain auto-overwrites the placeholder password from migration 0005 with this secret on each ensureSchema cycle. |
| `BRAIN_OPENAI_API_KEY` | OPENAI_API_KEY | embeddings + extraction + faithfulness verifier |
| `BRAIN_FORGET_HMAC_KEY` | FORGET_HMAC_KEY | ≥32 chars; used to mint opaque tombstone markers on GDPR forget |

Optional (off by default in workflow, opt in per-feature):
- `BRAIN_COHERE_API_KEY` — cross-encoder reranker
- `BRAIN_API_KEYS` — static `[{keyHash, companyId, scopes}]` JSON; only if you need a non-JWT fallback path. NODE_ENV=production + JWKS enabled rejects static keys, so leaving this empty is correct.

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
5. First request to any tenant triggers `ensureSchema` — migrations 0001-0009
   apply on the per-tenant `co_<companyId>` DB, including 0005 (PII PERMISSIONS
   + `brain_caller` user). No separate migration step needed.

## Subsequent deploys

`Run workflow → action=deploy` rebuilds and rolls. The container restart
is **not zero-downtime** — single replica today; brain in-flight requests
get aborted on swap. Acceptable for current traffic; revisit when caller
volume warrants.

## Operational dispatch actions

The workflow accepts three actions via `workflow_dispatch.inputs.action`:

- `deploy` (default) — full build + push + deploy.
- `restart` — skip build, restart the running container against the same
  image. Use for env-var rotations after editing `docker-compose.yml` on
  the droplet (rare — normal env changes go through workflow re-run).
- `logs` — print last 200 lines of the container log. Faster than SSH.

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

OpenTelemetry traces emit per-leg search spans. Push to a collector by
setting `OTEL_EXPORTER_OTLP_ENDPOINT` in the workflow env block (not set
by default — wire when collector exists in inite infra).

Prometheus metrics live at `/metrics` (in-process Prom-client). Traefik
isn't routing this externally — scrape via `http://inite-brain-service:3000/metrics`
from inside the docker network.

## Surface-level invariants the deploy depends on

- `inite-surrealdb` container is alive and joined to the docker network
  the brain container will be on. The temporal-stack workflow brings it
  up; if it's down, `pnpm test:eval` against prod won't even reach
  brain's health endpoint because brain crash-loops on missing DB.
- `auth.inite.ai` JWKS endpoint is reachable from the droplet. The
  ApiKeyGuard refuses to start in NODE_ENV=production without a valid
  JWKS load (defense-in-depth).
- Migration `0005_pii_permissions.surql` defines `brain_caller` with a
  static placeholder password (DDL doesn't bind to runtime variables).
  Right after the migration lands, brain runs
  `DEFINE USER OVERWRITE brain_caller PASSWORD $pass` against the root
  migrator connection using `SURREALDB_SCOPED_PASS`. If the secret is
  missing, the scoped pool gracefully degrades to root signin (defense-
  in-depth becomes app-only — DB-level fence not enforced). On password
  rotation: re-deploy. Brain's `ensureSchema` re-syncs the password
  once per process boot for any tenant DB that already has 0005 applied.
