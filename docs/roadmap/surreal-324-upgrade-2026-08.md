# SurrealDB 3.2.4 upgrade — validation + prod cutover runbook (2026-08)

Status: CI and the local stands are moved to `surrealdb/surrealdb:v3.2.4`
and the full gate ladder is green on it (numbers in §3). Prod still runs
3.1.5 in the SHARED `inite-surrealdb` container (7 databases: brain +
the other products' namespaces); the actual cutover is an OPERATOR
action via `ops-migrate-surrealdb.yml` in the content-generator repo —
NOT a change in this repo. This doc records why we move, the validation
evidence, the cutover plan, and the post-upgrade checklist.

## 1. Why 3.2.4 — the four wins mapped to recorded pains

| 3.2.4 change | Recorded pain it addresses |
|---|---|
| Concurrent-index-build stalls fixed | `DEFINE INDEX … HNSW` on a freshly-bulk-inserted table repeatedly aborted with RocksDB transaction conflicts on 3.1.5 — the V11 stand gotcha that forced "define the index BEFORE bulk load, or retry after compaction settles" (docs/roadmap/v10-audit-2026-08.md §HNSW). Index builds no longer stall against a live write load — directly relevant to building HNSW on production tenants that never stop ingesting. |
| Filtered-kNN + HNSW-cosine ~2.2× faster | Our coverage-lane KNN SQL carries the FULL gate tail inside the `<\|k,ef\|>` query (both scan lanes); filtered-kNN speedups apply verbatim. Cosine history: a stray cosine projection next to the KNN operator dropped the planner off KnnScan — measured 15× slower than brute and OOM-killed a 16GB SurrealDB 3.1.5 (src/synthesize/scan-leg.ts, scripts/scan-hnsw-parity.ts). The `vector::distance::knn()` idiom STAYS (it is the correct form regardless of server speed); the 2.2× is headroom on top. |
| Resumable index builds | The per-tenant enable ritual (build indexes → `scripts/scan-hnsw-parity.ts` recall ≥ 0.98 → flip `coverageScanMode`) runs synchronous `DEFINE INDEX` calls that "can take a while on a large tenant; run off-peak" (src/admin/hnsw-maintenance.service.ts). A restart mid-build no longer throws the work away, which shrinks the off-peak window the ritual needs. |
| Bounded write fan-out (`SURREAL_TRANSACTION_MAX_WRITE_KEYS`) | A safety ceiling on huge transactions — which we now have: `promoteStaging()` flips a WHOLE derived world (knowledge_fact + conversation_digest DELETE + UPDATE) in ONE transaction since the 2026-08-21 atomicity fix. See §5: verify the ceiling vs our biggest tenant before flipping derive in prod. |

## 2. What changed in this repo (branch `feat/surreal-324`)

- `test/global-setup.ts` — testcontainers pin `v3.1.5` → `v3.2.4`
  (rocksdb backend kept: mirrors production).
- `.github/workflows/ci.yml` — docker smoke-run image `v3.1.5` → `v3.2.4`.
- `docker-compose.yml` — local dev image `v3.2.0` → `v3.2.4`. Note for
  local devs: the compose volume upgrades forward on first start; going
  back to an older image afterwards requires wiping `surrealdb-data`.
- `docs/getting-started.md` — prerequisites line 3.1.5 → 3.2.4.

Deliberately NOT changed:

- `.github/workflows/deploy-brain.yml` — describes the shared prod
  container's CURRENT state (3.1.5); flips only at the actual cutover.
- Migration-file comments and roadmap docs saying "verified on 3.1.5" —
  historical verification records, not pins (and 0058's finding is
  re-verified on 3.2.4 below, so the guards they justify still stand).

## 3. Validation evidence — full gate ladder on 3.2.4

Stand: testcontainers `surrealdb/surrealdb:v3.2.4`
(`surrealdb-3.2.4+20260803.93ab219`), rocksdb backend, 2026-08-22.

| Gate | Result |
|---|---|
| Hermetic unit (`test/jest-unit.json`) | 255 suites / 2154 tests, all green (13.7s) |
| Full e2e (`test/jest-e2e.json --runInBand`, real SurrealDB 3.2.4) | 83 suites / 348 tests, all green (198s) — incl. lifecycle-0085, scan-hnsw, update-story EXPLAIN pins, abac-db-fence |
| Socket suite (`test/jest-socket.json`) | 6 suites / 106 tests, all green |
| `tsc -p tsconfig.spec.json` | clean |
| eslint (touched files) | clean |
| flag-budget + config-catalog-truth | 2 suites / 9 tests, green |

Behavior re-verification (the 3.1.5-era findings we depend on):

- **`NONE < time::now()` is still TRUE on 3.2.4** (probed directly via
  `/sql`). Migration 0058's `leaseUntil IS NOT NONE AND leaseUntil <
  time::now()` guard remains REQUIRED and correct — do not "simplify"
  it after the upgrade.
- **ABAC canary** (`test/abac-db-fence.e2e-spec.ts`): HELD (5/5 green,
  also re-run in isolation). 3.2.4 still IGNORES field PERMISSIONS for
  the `brain_caller` system user — the 0005/0057 fences remain inert,
  the app-layer JS filter remains the only active gate, and
  `ABAC_DB_FENCE_ENABLED` stays off. No behavior change; see §3.1 for
  what a future failure would mean.
- **Edge-fence traversal form** `->(knowledge_edge WHERE …)`
  (src/search/internals/edge-fence.ts, "stand-verified on 3.2") — now
  covered by the CI e2e run on 3.2.4, no longer stand-only.
- **`@N@` matches = AND-semantics** (operations.md,
  `RETRIEVAL_COVERAGE_LEX_MODE`) — unchanged; the coverage-lex e2e
  suites pass unmodified.
- **KNN idiom** — `vector::distance::knn()` projection still plans
  through KnnScan; `test/scan-hnsw.e2e-spec.ts` and
  `test/update-story-explain.e2e-spec.ts` (the EXPLAIN pins that exist
  precisely to catch server bumps) pass on 3.2.4.

### 3.1 The ABAC canary — what a failure would mean

`test/abac-db-fence.e2e-spec.ts` deliberately asserts the 3.1.5-era
finding that SurrealDB IGNORES field `PERMISSIONS` for the
`brain_caller` SYSTEM user — i.e. the 0005 PII fence and the 0057
policy fence are inert and the app-layer JS filter is the only active
gate. If 3.2.4 (or any future bump) starts honouring PERMISSIONS, the
canary FAILS ON PURPOSE. That is a FINDING, not a flake: flip the
canary's expectations, activate the DB fence (enable
`ABAC_DB_FENCE_ENABLED` in prod runbooks, update `docs/abac.md` and
0057's header) — and celebrate the free defense-in-depth layer. Never
silence it.

## 4. Prod cutover plan (operator action, content-generator repo)

Prod SurrealDB is a SHARED container (`inite-surrealdb`, in the
inite-temporal stack) holding 7 databases across products — brain owns
only NS=brain. Brain does NOT own the change window; coordinate with
the other consumers first. The mechanics live in the content-generator
repo's `ops-migrate-surrealdb.yml` (the 2.x → 3.1.5 workflow is the
template; this bump is SIMPLER — same storage engine, no export/
transform pipeline, rocksdb upgrades forward in place).

1. **Validate** — dry-run against a copy on a throwaway volume first
   (the workflow's `action=validate` pattern: no quiesce, no downtime;
   iterate until green).
2. **Quiesce writers** — stop ALL consumers, including
   `inite-brain-service` (its job-lease heartbeats write every 10-30s)
   and the gateway, then stop `inite-surrealdb` itself.
3. **NEW volume** — copy the rocksdb data dir from the live volume to a
   fresh volume (e.g. `surrealdb-data-v324`). The OLD volume is never
   mounted by 3.2.4 and is KEPT as the rollback point.
4. **Deploy** — update deploy-temporal.yml: image `v3.2.4`, mount the
   NEW volume; recreate the container. 3.2.4 opens the 3.1-written data
   and upgrades it forward on first start.
5. **Smoke** — `/health` of brain against the upgraded server, one
   scoped-pool read, one ingest, `SELECT count()` spot-checks per ns.
6. **Start consumers** — the workflow's `start-consumers` action.

**Rollback = the OLD volume, and it is forward-only from there.** A
3.1.5 server CANNOT open anything 3.2 has written — it fails with
"Invalid revision" (observed live on the eval stand: 3.2.1-written
index state opened under 3.1.5 → "Invalid revision for
IndexBuildState", docs/roadmap/v11-session-2026-08.md). So rollback =
revert deploy-temporal.yml to v3.1.5 + the old volume, which restores
the world AS OF THE QUIESCE — any writes made after cutover are lost.
Keep the soak window short and the go/no-go decision explicit; never
try to point 3.1.5 at the new volume.

## 5. Post-upgrade checklist

- [ ] **HNSW parity per tenant BEFORE re-enabling HNSW legs**: re-run
  `scripts/scan-hnsw-parity.ts` (recall ≥ 0.98 gate; exit 1 = FAIL,
  exit 2 = SKIP below `--min-probes`) for every tenant with a
  `coverageScanMode` override, then re-flip. Index internals moved
  between 3.1 and 3.2; do not carry the old recall evidence forward.
- [ ] **U8/I8 quantized HNSW re-benchmark**: the 3.2 line's HNSW-cosine
  speedups shift the recall/latency/RAM tradeoff — re-run the 20k×384
  probe matrix with quantized types before deciding the default stays
  F32.
- [ ] **`SURREAL_TRANSACTION_MAX_WRITE_KEYS` vs derive flips**:
  `promoteStaging()` full-run shape deletes + updates an entire derived
  world (knowledge_fact + conversation_digest) in ONE transaction.
  Measure the biggest tenant's world size (rows ≈ write keys incl.
  index entries) against the server's ceiling BEFORE running a full
  derive flip on prod 3.2.4; raise the env on the shared container or
  fall back to per-conversation targeted flips if it's tight.
- [ ] **Keep the 0058 guard** — `NONE < time::now()` is still TRUE on
  3.2.4 (§3); the `IS NOT NONE` clause stays.
- [ ] **Watch the ABAC canary in CI** — the run where it fails is the
  day PERMISSIONS started firing (§3.1).
- [ ] **Pin the eval stand**: loco-321 currently runs `surrealdb:latest`
  (3.2.1) — pin it to `v3.2.4` at its next restart so stand, CI, and
  prod converge on one version (the mixed-version "Invalid revision"
  wedge class dies with the pin).
- [ ] **Flip deploy-brain.yml's prose** describing the shared container
  after the cutover actually happens (it documents current prod state,
  so it changes LAST).
