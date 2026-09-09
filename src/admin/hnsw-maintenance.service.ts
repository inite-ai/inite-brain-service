import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { probeHnswIndex, resetKnnIndexMemo } from '../db/knn-index';

/**
 * HnswMaintenanceService — per-tenant HNSW index lifecycle.
 *
 * The vector leg full-scans cosine by design at walking-skeleton scale
 * (faster end-to-end than an index build, see the commented-out DDL in
 * schema.surql). Past ~50k active facts that flips, but the index can't
 * be a static migration: HNSW DIMENSION must match the tenant's LIVE
 * embedder (openai 1536 vs bge-m3 1024), which is deploy-config, not
 * schema. So creation is an explicit admin action per tenant:
 *
 *   1. POST /v1/admin/maintenance/hnsw {action:'create'} per tenant;
 *   2. flip SEARCH_HNSW_ENABLED=1 — the KNN leg kicks in, and tenants
 *      without indexes fall back to the full scan;
 *   3. re-run the quality eval — filtered KNN is approximate; the
 *      over-fetch knob (SEARCH_HNSW_OVERFETCH) trades recall for speed.
 *
 * Embedder swap (dimension change). The width is baked into the index
 * DDL, and once an index exists every write of a differently-sized
 * vector is rejected — which ALSO blocks the reindex that would fix it.
 * `create` therefore RECREATES unconditionally: it removes each index
 * and defines it again at the declared width.
 *
 * There is deliberately no "the index is at the old width" branch. That
 * compatibility path would exist for a state no deployment is in, and it
 * would have to be carried forever for a case that never arrives.
 * Recreating is also strictly safer than the guard it replaces:
 * `DEFINE INDEX IF NOT EXISTS` SILENTLY NO-OPS when an index exists at a
 * different dimension (verified on 3.1.5), so the previous code could
 * only detect-and-refuse, leaving the operator to run a three-call
 * drop → reindex → create sequence by hand. An unconditional recreate
 * cannot leave a stale index behind and cannot be done in the wrong
 * order.
 *
 * The swap ORDER still matters for the DATA: recreate leaves the index
 * matching the embedder, but rows embedded in the old space are still
 * old-width, so run the embedding reindex (POST
 * /v1/admin/reindex/embeddings) BEFORE `create` — with no index present
 * the rewrites it must perform are not rejected.
 *
 * Two indexes, each with a consumer: fact_embedding_hnsw rides under the
 * fact legs, the dedup seed and inline entity resolution (all `<|K,EF|>`
 * over knowledge_fact.embedding); segment_embedding_hnsw rides under the
 * segment legs, the segment lane and the coverage-scan lane
 * (episode_segment.embedding). fact_alt_embedding_hnsw (a column with no
 * writer since the HyPE experiment was reverted) and entity_embedding_hnsw
 * (knowledge_entity.embedding has no KNN and no cosine consumer — entity
 * resolution reads fact vectors) were retired by migration 0139: they were
 * built, waited for and counted in readiness for nothing.
 *
 * segment_embedding_hnsw has a swap caveat: the reindex sweep re-embeds
 * episode_segment along with the other swept tables (reindex-engine
 * ADDITIONAL_TABLE_SPECS), and a segment world can also be rebuilt from
 * its episodes (0075).
 *
 * ── Every build is CONCURRENTLY ────────────────────────────────────────
 *
 * Synchronous `DEFINE INDEX … HNSW` does not merely block at real scale,
 * it FAILS. Measured on `surrealdb/surrealdb:v3.2.4`, 20 000 × 1024-d:
 * the statement aborts after ~133 s with a RocksDB transaction conflict
 * ("MemTable only contains changes newer than SequenceNumber …"),
 * reproduced after a 30 s settle at 140 s with the same failure. The same
 * DDL with `CONCURRENTLY` reaches `ready` in 4.2 s (~4 700 rows/s). The
 * synchronous form used to sit behind SEARCH_HNSW_CONCURRENT=0 as the
 * default; a default that is a measured failure at exactly the corpus size
 * the index exists for is not a configuration, so there is one path now.
 *
 * `create` also emits one DEFINE per index rather than a multi-index
 * super-statement: a concurrent build is per-index by nature (each has
 * its own `building` progress), and a single failing DEFINE inside a
 * multi-statement query takes its siblings with it.
 *
 * READINESS. A concurrent build EXISTS the moment the DDL returns and is
 * NOT usable until it reports `ready`. Measured on the same container:
 * while `INFO FOR INDEX` says `{"initial":16,"pending":0,"status":
 * "indexing"}`, a `<|K,EF|>` query returns the SAME unranked, null-distance
 * table-order rows it returns with no index at all; only at
 * `{"status":"ready"}` do real distances come back. "The index exists" is
 * therefore NOT the property an operator may act on before flipping
 * SEARCH_HNSW_ENABLED — `ready` is. Every result this service returns
 * carries the per-index build state rather than letting the caller assume
 * it, and `action: 'status'` reports it without touching any DDL.
 *
 * ── `ensure` — the idempotent action provisioning is allowed to call ──
 *
 * `create` RECREATES: it REMOVEs both indexes and defines them again.
 * That is right for an operator repairing a width swap and catastrophic for
 * anything automatic — a provisioning hook that ran `create` on process
 * boot would drop a large tenant's working indexes and leave it serving
 * unranked rows for the length of the rebuild, which is the very state #506
 * exists to end.
 *
 * `ensure` is the non-destructive half: probe, define ONLY the indexes that
 * are `absent`, never REMOVE, never wait for a build. Re-running it on a
 * ready tenant emits no DDL at all, and re-running it while a build is in
 * flight leaves that build alone — so it is safe on every pass, which is
 * what a reconciliation sweep needs.
 *
 * `ensure` never waits for the build it starts: the DDL returns and the
 * sweep moves on, and the tenant registry records the build state as it
 * is observed. Only an explicit `create` waits (see `waitMs`).
 *
 * WIDTH IS PART OF READINESS. An index that exists at the wrong DIMENSION
 * is `ready` to `INFO FOR INDEX` and useless in fact: every write of a
 * correctly-sized vector is rejected against it. `ensure` cannot fix that
 * (the repair is reindex → `create`, and it destroys data), so it does the
 * only honest thing — reports the mismatch and refuses to call the tenant
 * ready. The declared DIMENSION is parsed out of the same `INFO FOR TABLE`
 * response the existence probe already fetched, so it costs nothing.
 */
export type HnswIndexBuildState = 'ready' | 'building' | 'absent' | 'unknown';

/** Every action this service can be asked to perform. */
export type HnswMaintenanceAction = 'create' | 'drop' | 'status' | 'ensure';

/** Per-index build state, as reported by `INFO FOR INDEX`. */
export interface HnswIndexBuild {
  index: string;
  table: string;
  state: HnswIndexBuildState;
  /** Rows walked by the initial build, when the engine reports it. */
  initial?: number;
  /** Rows queued behind the build (live writes), when reported. */
  pending?: number;
  /**
   * DIMENSION declared in the index's own DDL, parsed from `INFO FOR
   * TABLE`. Absent when the index is absent or the probe failed. A value
   * other than the result's `dimension` means the index cannot accept the
   * embedder's vectors at all.
   */
  dimension?: number;
}

export interface HnswMaintenanceResult {
  companyId: string;
  action: HnswMaintenanceAction;
  dimension: number;
  /**
   * Canonical id of the PRIMARY embedding space the width came from
   * (`provider:model:dim:norm`). Recorded alongside the index state so a
   * later "ready" can be read against the space it was ready FOR — width
   * alone cannot distinguish two models at the same width.
   */
  space: string;
  indexes: string[];
  /**
   * Always true: every build is `CONCURRENTLY` (the synchronous form is a
   * measured failure at scale, see the class docstring). Kept on the wire
   * so an operator script written against the flagged shape keeps parsing.
   */
  concurrent: true;
  /**
   * True only when EVERY index reports `ready` AT THE DECLARED WIDTH. Do
   * not flip SEARCH_HNSW_ENABLED for this tenant while it is false — a
   * still-building index serves unranked rows exactly as a missing one
   * does, and a ready index at a foreign width rejects every write. `drop`
   * reports `ready: false` with every index `absent`.
   */
  ready: boolean;
  builds: HnswIndexBuild[];
  /**
   * Indexes that exist at a DIMENSION other than the embedder's. Empty in
   * every healthy deployment. Non-empty means the tenant needs the
   * destructive repair (reindex embeddings, then `create`); `ensure` will
   * not perform it and will not report `ready`.
   */
  mismatched: string[];
  /**
   * Indexes this call actually DEFINEd. Always empty for `status` and
   * `drop`; for `ensure` it is exactly the set that was absent, which is
   * what makes "did this run change anything" answerable from the result.
   */
  created: string[];
}

const FACT_MAIN = 'fact_embedding_hnsw';
const SEGMENT_MAIN = 'segment_embedding_hnsw';

/** Every index this service owns, with the table and column it rides. */
const INDEX_SPECS = [
  { index: FACT_MAIN, table: 'knowledge_fact', field: 'embedding' },
  { index: SEGMENT_MAIN, table: 'episode_segment', field: 'embedding' },
] as const;

/**
 * How long `create` waits for the concurrent builds before answering with
 * whatever progress it reached. A per-call parameter of the admin request
 * (`waitMs`), not an environment knob: how long ONE operator is willing to
 * hold ONE request is not deployment configuration. Not a failure ceiling —
 * the build keeps running server-side and `action:'status'` reports it —
 * just the point at which holding the HTTP request stops being the useful
 * thing to do. The 60 s default covers ~280k rows at the measured ~4 700
 * rows/s; 0 answers immediately with the first probe.
 */
export const DEFAULT_BUILD_WAIT_MS = 60_000;
/** Longest wait a single request may ask for — past this, poll `status`. */
export const MAX_BUILD_WAIT_MS = 600_000;
const BUILD_POLL_MS = 2_000;

/** Per-call options of {@link HnswMaintenanceService.apply}. */
export interface HnswApplyOptions {
  /**
   * `create` only: how long to wait for the builds before answering, in
   * milliseconds, 0 ≤ waitMs ≤ {@link MAX_BUILD_WAIT_MS}. Absent → the
   * 60 s default. Ignored by `ensure` (never waits), `status` and `drop`.
   */
  waitMs?: number;
}

/** Validate a caller-supplied wait; a bad value is a 400, never a silent default. */
export function resolveBuildWaitMs(waitMs: number | undefined): number {
  if (waitMs === undefined) return DEFAULT_BUILD_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_BUILD_WAIT_MS) {
    throw new BadRequestException(
      `waitMs must be an integer between 0 and ${MAX_BUILD_WAIT_MS} (milliseconds)`,
    );
  }
  return waitMs;
}

/**
 * The one DEFINE INDEX failure `ensure` treats as success. Measured verbatim
 * on surrealdb/surrealdb:v3.2.4: `The index 'fact_embedding_hnsw' already
 * exists`. Matched on the shape rather than the exact sentence so a wording
 * change degrades to a loud failure, never to a swallowed one.
 */
const ALREADY_EXISTS = /index .* already exists/i;

@Injectable()
export class HnswMaintenanceService {
  private readonly logger = new Logger(HnswMaintenanceService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async apply(
    companyId: string,
    action: HnswMaintenanceAction,
    opts: HnswApplyOptions = {},
  ): Promise<HnswMaintenanceResult> {
    // Validated before any DDL: a malformed wait must not cost a rebuild.
    const waitMs = resolveBuildWaitMs(opts.waitMs);
    // PRIMARY, not active: getDimensions() reports whoever is serving, so
    // an index build triggered during the bge-m3 warmup window would bake
    // the OpenAI fallback's 1536 into DDL for a 1024 corpus — an index the
    // primary can never write to once warm.
    const dimension = this.embedder.primaryDimensions();
    if (!Number.isInteger(dimension) || dimension < 8 || dimension > 8192) {
      throw new BadRequestException(`embedder reports implausible dimension ${dimension}`);
    }
    const concurrent = true;
    // The DDL and the first probe share one pool hold; the build WAIT does
    // not — each poll takes a connection for the INFO statements and gives
    // it back, so a 60 s wait no longer pins a root-pool slot (and the
    // migrator, which needs one, cannot deadlock behind it).
    const created: string[] = [];
    let builds = await this.surreal.withCompany(companyId, async (db) => {
      if (action === 'create') await this.create(db, dimension);
      else if (action === 'drop') await this.drop(db);
      else if (action === 'ensure') created.push(...(await this.ensure(db, dimension)));
      return this.probeBuilds(db);
    });
    // Only an explicit create waits: `ensure` is the provisioner's sweep
    // action and returns as soon as the DDL is issued (the sweep moves on;
    // the tenant registry records the build state as it is observed).
    if (action === 'create' && !builds.every((b) => b.state === 'ready')) {
      builds = await this.waitForBuilds(companyId, builds, waitMs);
    }
    // The legs remember an index they saw missing or building; a build or
    // drop makes that memory stale on every pod that shares this process.
    if (action !== 'status') resetKnnIndexMemo();
    const mismatched = builds
      .filter((b) => b.dimension !== undefined && b.dimension !== dimension)
      .map((b) => b.index);
    const ready =
      action !== 'drop' && mismatched.length === 0 && builds.every((b) => b.state === 'ready');
    this.report(companyId, { action, dimension, concurrent, ready, builds, mismatched, created });
    return {
      companyId,
      action,
      dimension,
      space: this.embedder.primarySpaceId(),
      indexes: INDEX_SPECS.map((s) => s.index),
      concurrent,
      ready,
      builds,
      mismatched,
      created,
    };
  }

  /** Every log line `apply` emits, kept out of the happy path's way. */
  private report(
    companyId: string,
    r: Omit<HnswMaintenanceResult, 'companyId' | 'indexes' | 'space'>,
  ): void {
    const states = r.builds.map((b) => `${b.index}=${b.state}`).join(', ');
    if (r.action !== 'status' && !(r.action === 'ensure' && r.created.length === 0)) {
      this.logger.log(
        `hnsw ${r.action} for ${companyId} (dimension=${r.dimension}, ` +
          `concurrent=${r.concurrent}, ready=${r.ready}` +
          `${r.created.length > 0 ? `, created=[${r.created.join(', ')}]` : ''})`,
      );
    }
    if (r.mismatched.length > 0) {
      // ERROR, not warn: with SEARCH_HNSW_ENABLED=1 this tenant's writes of
      // correctly-sized vectors are being REJECTED by its own index, and no
      // automatic action can fix it — the repair destroys and rebuilds.
      this.logger.error(
        `hnsw index width mismatch for ${companyId}: [${r.mismatched.join(', ')}] exist at a ` +
          `DIMENSION other than the embedder's ${r.dimension}. Every write of a correctly-sized ` +
          `vector is rejected against them. Repair in order: reindex embeddings, then POST ` +
          `/v1/admin/maintenance/hnsw {action:'create'} (which recreates at the current width).`,
      );
    }
    if ((r.action === 'create' || r.created.length > 0) && !r.ready) {
      // Loud on purpose: the operator's next step is flipping
      // SEARCH_HNSW_ENABLED, and a not-yet-ready index answers that flag
      // with unranked rows rather than an error.
      this.logger.warn(
        `hnsw ${r.action} for ${companyId} returned with builds NOT ready (${states}); ` +
          `poll POST /v1/admin/maintenance/hnsw {action:'status'} before enabling SEARCH_HNSW_ENABLED`,
      );
    }
  }

  /**
   * Define the indexes that are ABSENT, and only those. Returns the names
   * it defined, so an empty array means the call emitted no DDL.
   *
   * `building` is deliberately left alone rather than restarted: #507
   * measured that a build in flight is indistinguishable from a missing
   * index to a KNN query, so a sweep that "fixed" it on every pass would
   * restart the same build forever and never reach ready. `unknown` is left
   * alone too — a failed probe is not evidence of absence.
   *
   * THE RACE IS EXPECTED AND BENIGN. `DEFINE INDEX` without IF NOT EXISTS
   * does not no-op on an existing index, it ERRORS: measured on
   * surrealdb/surrealdb:v3.2.4, "The index 'fact_embedding_hnsw' already
   * exists". Two pods reconciling the same fresh tenant will therefore see
   * one DEFINE win and one lose, and the loser's error means the index it
   * wanted now exists — the desired state, reached by someone else. That
   * one message is swallowed per index; anything else propagates.
   *
   * (IF NOT EXISTS is deliberately NOT used instead: on a DIMENSION change
   * it silently no-ops, which is the exact trap the previous create-guard
   * existed to catch. An error we can recognise beats a silence we cannot.)
   */
  private async ensure(db: Surreal, dimension: number): Promise<string[]> {
    const builds = await this.probeBuilds(db);
    const absent = INDEX_SPECS.filter(
      (spec) => builds.find((b) => b.index === spec.index)?.state === 'absent',
    );
    const created: string[] = [];
    for (const spec of absent) {
      try {
        // DIMENSION cannot be parameterised in DDL — `dimension` comes from
        // the space declaration and is range-validated by the caller.
        await db.query(
          `DEFINE INDEX ${spec.index} ON ${spec.table} FIELDS ${spec.field}
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16 CONCURRENTLY;`,
        );
        created.push(spec.index);
      } catch (e) {
        if (!ALREADY_EXISTS.test((e as Error).message)) throw e;
        this.logger.log(
          `hnsw ensure: ${spec.index} was created concurrently by another writer — ` +
            `the desired state, reached elsewhere`,
        );
      }
    }
    return created;
  }

  /**
   * RECREATE at the declared width: remove first, then define each index
   * on its own statement, CONCURRENTLY, so one failure cannot take the
   * other with it and each build has its own progress row.
   */
  private async create(db: Surreal, dimension: number): Promise<void> {
    // DIMENSION cannot be parameterised in DDL — `dimension` comes from
    // the space declaration and is range-validated by the caller, never
    // caller input.
    const define = (spec: (typeof INDEX_SPECS)[number]) =>
      `DEFINE INDEX ${spec.index} ON ${spec.table} FIELDS ${spec.field}
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16 CONCURRENTLY;`;
    await this.drop(db);
    for (const spec of INDEX_SPECS) await db.query(define(spec));
  }

  private async drop(db: Surreal): Promise<void> {
    await db.query(
      `REMOVE INDEX IF EXISTS ${FACT_MAIN} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${SEGMENT_MAIN} ON episode_segment;`,
    );
  }

  /**
   * Poll until every build reports ready, or the wait ceiling elapses.
   * Each poll acquires and releases its own connection; the wait itself
   * holds nothing. Returns the last observation either way.
   */
  private async waitForBuilds(
    companyId: string,
    last: HnswIndexBuild[],
    waitMs: number,
  ): Promise<HnswIndexBuild[]> {
    const deadline = Date.now() + waitMs;
    let builds = last;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, BUILD_POLL_MS));
      builds = await this.surreal.withCompany(companyId, (db) => this.probeBuilds(db));
      if (builds.every((b) => b.state === 'ready')) return builds;
    }
    return builds;
  }

  /**
   * Per-index build state, through the same probe the KNN legs use
   * (knn-index.ts): `INFO FOR INDEX` THROWS on an index that does not
   * exist, so existence is probed on the table first; a synchronously built
   * index reports no `building` block at all, which is `ready`. The probe
   * also reads the DIMENSION the engine echoes back, which is how a width
   * mismatch is detected.
   */
  private async probeBuilds(db: Surreal): Promise<HnswIndexBuild[]> {
    const out: HnswIndexBuild[] = [];
    for (const spec of INDEX_SPECS) {
      const probe = await probeHnswIndex(db, spec);
      if (probe.state === 'unknown') this.logger.warn(`hnsw probe failed for ${spec.index}`);
      out.push({ index: spec.index, table: spec.table, ...probe });
    }
    return out;
  }
}
