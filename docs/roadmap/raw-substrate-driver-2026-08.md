# Raw substrate as a universal driver (design draft, 2026-08)

Course correction (owner, 2026-07-31): the raw layer must be a
universal API contract, not a bare table our services happen to query.
Any service on top keeps working while projections are rebuilt
underneath; otherwise the substrate is an eval-shaped artifact.

## State of play

What the raw layer IS today:

- `episode` rows in SurrealDB: immutable, idempotent, LLM-free capture
  BEFORE extraction (EPISODE_SUBSTRATE_ENABLED / INGEST_EPISODE_ONLY).
  Written only by the ingest path (`/v1/ingest/mention`).
- Read by FIVE internal services via direct `FROM episode` queries:
  window-deriver, segment-composer, agent-qa, episode-lane,
  segment-lane. No shared port; the table schema IS the contract.
- NO public read surface: no range read, no replay/export, no
  subscription. External consumers cannot build their own projections
  without speaking SurrealQL to our database.
- Projections (facts@derivedVersion, segments) are rebuildable — but
  through admin batch endpoints (`/maintenance/derive` with force)
  born for eval re-runs; incremental derivation (watermarks) was
  deferred at P3.

What is already RIGHT and must not be lost:

- L0 is a true event log (immutable, idempotent, pre-extraction).
- Versioned derived worlds + `RETRIEVAL_DERIVED_VERSION` pin flip =
  atomic projection swap with the old world queryable until GC. This
  is the rebuild primitive; the driver formalizes it, not replaces it.
- Per-tenant isolation, ABAC, scoped keys already fence the raw layer.

## Target contract (v1)

Four surfaces, smallest first; each shippable independently, all
flag-gated, all additive (no existing consumer breaks):

1. **Raw read API** — `GET /v1/episodes`: cursor pagination over
   (occurredAt, id), filters conversationRef/speaker/time-range; and
   `GET /v1/episodes/export` streaming NDJSON for replay. PII fence:
   same piiClass gate the episodic lane already applies (episodes are
   the rawest PII surface we have — brain:read_pii required for text,
   metadata-only shape without it). This alone makes every consumer's
   "build your own projection" possible.
2. **Internal EpisodeStore port** — one repository interface; migrate
   the five direct readers onto it. No behavior change; the point is
   that the episode schema stops being load-bearing across five files
   and the storage engine becomes swappable in principle.
3. **Projection registry** — first-class records for each derived
   surface (facts@wd-v2, segments@v, communities@v, …): status,
   watermark, builder identity, rebuild endpoint. `POST
   /v1/projections/:name/rebuild` supersedes the maintenance batch as
   the public verb (the batch stays as its internal engine).
   Incremental derivation (the deferred P3-full watermark work) slots
   in here as the builder's resume mechanism — not a new concept.
4. **Change subscription** — new-episode notifications for external
   projection builders: reuse the indexer webhook-push pattern
   (registered endpoint + HMAC), changefeed-driven. SSE later if a
   consumer actually needs it.

## Non-goals (v1)

- Not a generic SurrealDB proxy: the contract exposes EPISODES and
  PROJECTIONS, never tables.
- No projection plugin runtime beyond what packs/indexers already
  provide — external builders consume the read/subscribe API with
  their own keys (the marketplace/indexer machinery already handles
  registration, consent, billing fences).
- No storage swap. The port makes it thinkable; nothing more.

## Sequencing note

Eval work (typed lanes T1–T7) is read-side prompt shaping behind
default-off flags and does not touch this layer; the two tracks do not
contend. The eval-shaped parts of the derive path (batch force,
harness asOf conventions) become internal details behind the
projection registry rather than the public story.
