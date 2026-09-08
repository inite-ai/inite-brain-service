import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { envFlagEnabled } from '../common/env-validation';

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
 * segment_embedding_hnsw (the coverage-scan leg, V11 §5) has a swap
 * caveat: reindex-embeddings rewrites knowledge_fact ONLY — segments
 * keep their old-size vectors. Segments are derived state (0075), so
 * the segment step of a swap is delete + re-segment the world;
 * entity_embedding_hnsw shares the same hole and today relies on entity
 * vectors being rewritten by their own ingest path.
 *
 * ── SEARCH_HNSW_CONCURRENT (default off) ──────────────────────────────
 *
 * Synchronous `DEFINE INDEX … HNSW` does not merely block at real scale,
 * it FAILS. Measured on `surrealdb/surrealdb:v3.2.4`, 20 000 × 1024-d:
 * the statement aborts after ~133 s with a RocksDB transaction conflict
 * ("MemTable only contains changes newer than SequenceNumber …"),
 * reproduced after a 30 s settle at 140 s with the same failure. The same
 * DDL with `CONCURRENTLY` reaches `ready` in 4.2 s (~4 700 rows/s). So the
 * only index-build path this service has is broken at exactly the corpus
 * size the index exists for, and the fix is one keyword.
 *
 * With the flag on, `create` also stops emitting one four-index
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
 * SEARCH_HNSW_ENABLED — `ready` is. Every result this service returns now
 * carries the per-index build state rather than letting the caller assume
 * it, on both the concurrent and the synchronous path, and `action:
 * 'status'` reports it without touching any DDL.
 */
export type HnswIndexBuildState = 'ready' | 'building' | 'absent' | 'unknown';

/** Per-index build state, as reported by `INFO FOR INDEX`. */
export interface HnswIndexBuild {
  index: string;
  table: string;
  state: HnswIndexBuildState;
  /** Rows walked by the initial build, when the engine reports it. */
  initial?: number;
  /** Rows queued behind the build (live writes), when reported. */
  pending?: number;
}

export interface HnswMaintenanceResult {
  companyId: string;
  action: 'create' | 'drop' | 'status';
  dimension: number;
  indexes: string[];
  /** Whether the DDL was emitted with CONCURRENTLY (SEARCH_HNSW_CONCURRENT). */
  concurrent: boolean;
  /**
   * True only when EVERY index reports `ready`. Do not flip
   * SEARCH_HNSW_ENABLED for this tenant while it is false — a
   * still-building index serves unranked rows exactly as a missing one
   * does. `drop` reports `ready: false` with every index `absent`.
   */
  ready: boolean;
  builds: HnswIndexBuild[];
}

const FACT_MAIN = 'fact_embedding_hnsw';
const FACT_ALT = 'fact_alt_embedding_hnsw';
const ENTITY_MAIN = 'entity_embedding_hnsw';
const SEGMENT_MAIN = 'segment_embedding_hnsw';

/** Every index this service owns, with the table and column it rides. */
const INDEX_SPECS = [
  { index: FACT_MAIN, table: 'knowledge_fact', field: 'embedding' },
  { index: FACT_ALT, table: 'knowledge_fact', field: 'altEmbedding' },
  { index: ENTITY_MAIN, table: 'knowledge_entity', field: 'embedding' },
  { index: SEGMENT_MAIN, table: 'episode_segment', field: 'embedding' },
] as const;

/**
 * How long `create` waits for the concurrent builds before answering with
 * whatever progress it reached (SEARCH_HNSW_BUILD_WAIT_MS). Not a failure
 * ceiling — the build keeps running server-side and `action:'status'`
 * reports it — just the point at which holding the HTTP request (and its
 * pooled connection) stops being the useful thing to do. The 60 s default
 * covers ~280k rows at the measured ~4 700 rows/s; 0 answers immediately
 * with the first probe.
 */
const DEFAULT_BUILD_WAIT_MS = 60_000;
const BUILD_POLL_MS = 500;

@Injectable()
export class HnswMaintenanceService {
  private readonly logger = new Logger(HnswMaintenanceService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  /** Read at call time, never captured — the knob stays runtime-mutable. */
  private static concurrentEnabled(): boolean {
    return envFlagEnabled(process.env.SEARCH_HNSW_CONCURRENT);
  }

  /** Same: read per call, so an operator can widen the wait for a huge
   *  tenant without a restart. Invalid/absent → the 60 s default. */
  private static buildWaitMs(): number {
    const raw = Number.parseInt(process.env.SEARCH_HNSW_BUILD_WAIT_MS ?? '', 10);
    return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_BUILD_WAIT_MS;
  }

  async apply(
    companyId: string,
    action: 'create' | 'drop' | 'status',
  ): Promise<HnswMaintenanceResult> {
    // PRIMARY, not active: getDimensions() reports whoever is serving, so
    // an index build triggered during the bge-m3 warmup window would bake
    // the OpenAI fallback's 1536 into DDL for a 1024 corpus — an index the
    // primary can never write to once warm.
    const dimension = this.embedder.primaryDimensions();
    if (!Number.isInteger(dimension) || dimension < 8 || dimension > 8192) {
      throw new BadRequestException(`embedder reports implausible dimension ${dimension}`);
    }
    const concurrent = HnswMaintenanceService.concurrentEnabled();
    return this.surreal.withCompany(companyId, async (db) => {
      if (action === 'create') await this.create(db, dimension, concurrent);
      else if (action === 'drop') await this.drop(db);
      const builds = await this.probeBuilds(db);
      const ready = action !== 'drop' && builds.every((b) => b.state === 'ready');
      if (action !== 'status') {
        this.logger.log(
          `hnsw ${action} for ${companyId} (dimension=${dimension}, concurrent=${concurrent}, ready=${ready})`,
        );
      }
      if (action === 'create' && !ready) {
        // Loud on purpose: the operator's next step is flipping
        // SEARCH_HNSW_ENABLED, and a not-yet-ready index answers that flag
        // with unranked rows rather than an error.
        this.logger.warn(
          `hnsw create for ${companyId} returned with builds NOT ready ` +
            `(${builds.map((b) => `${b.index}=${b.state}`).join(', ')}); ` +
            `poll POST /v1/admin/maintenance/hnsw {action:'status'} before enabling SEARCH_HNSW_ENABLED`,
        );
      }
      return {
        companyId,
        action,
        dimension,
        indexes: INDEX_SPECS.map((s) => s.index),
        concurrent,
        ready,
        builds,
      };
    });
  }

  /**
   * RECREATE at the declared width. Concurrent off keeps the historical
   * single super-statement byte-for-byte; concurrent on removes first,
   * then defines each index on its own so one failure cannot take the
   * other three with it and each build has its own progress row.
   */
  private async create(db: Surreal, dimension: number, concurrent: boolean): Promise<void> {
    // DIMENSION cannot be parameterised in DDL — `dimension` comes from
    // the space declaration and is range-validated by the caller, never
    // caller input.
    const define = (spec: (typeof INDEX_SPECS)[number], suffix: string) =>
      `DEFINE INDEX ${spec.index} ON ${spec.table} FIELDS ${spec.field}
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16${suffix};`;
    if (!concurrent) {
      await db.query(
        `REMOVE INDEX IF EXISTS ${FACT_MAIN} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${FACT_ALT} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${ENTITY_MAIN} ON knowledge_entity;
           REMOVE INDEX IF EXISTS ${SEGMENT_MAIN} ON episode_segment;
           DEFINE INDEX ${FACT_MAIN} ON knowledge_fact FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX ${FACT_ALT} ON knowledge_fact FIELDS altEmbedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX ${ENTITY_MAIN} ON knowledge_entity FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX ${SEGMENT_MAIN} ON episode_segment FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;`,
      );
      return;
    }
    await this.drop(db);
    for (const spec of INDEX_SPECS) await db.query(define(spec, ' CONCURRENTLY'));
    await this.waitForBuilds(db);
  }

  private async drop(db: Surreal): Promise<void> {
    await db.query(
      `REMOVE INDEX IF EXISTS ${FACT_MAIN} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${FACT_ALT} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${ENTITY_MAIN} ON knowledge_entity;
           REMOVE INDEX IF EXISTS ${SEGMENT_MAIN} ON episode_segment;`,
    );
  }

  /** Poll until every build reports ready, or the wait ceiling elapses. */
  private async waitForBuilds(db: Surreal): Promise<void> {
    const deadline = Date.now() + HnswMaintenanceService.buildWaitMs();
    for (;;) {
      const builds = await this.probeBuilds(db);
      if (builds.every((b) => b.state === 'ready')) return;
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, BUILD_POLL_MS));
    }
  }

  /**
   * Per-index build state. `INFO FOR INDEX` THROWS on an index that does
   * not exist, so existence is probed on the table first; a synchronously
   * built index reports no `building` block at all, which is `ready`.
   */
  private async probeBuilds(db: Surreal): Promise<HnswIndexBuild[]> {
    const out: HnswIndexBuild[] = [];
    for (const spec of INDEX_SPECS) {
      out.push({ index: spec.index, table: spec.table, ...(await this.probeOne(db, spec)) });
    }
    return out;
  }

  private async probeOne(
    db: Surreal,
    spec: (typeof INDEX_SPECS)[number],
  ): Promise<{ state: HnswIndexBuildState; initial?: number; pending?: number }> {
    try {
      const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
        `INFO FOR TABLE ${spec.table};`,
      );
      const indexes = (info as { indexes?: Record<string, string> } | undefined)?.indexes;
      if (!indexes || typeof indexes[spec.index] !== 'string') return { state: 'absent' };
      const [detail] = await db.query<
        [{ building?: { status?: string; initial?: number; pending?: number } }]
      >(`INFO FOR INDEX ${spec.index} ON ${spec.table};`);
      const building = (
        detail as { building?: { status?: string; initial?: number; pending?: number } } | undefined
      )?.building;
      if (!building || building.status === undefined) return { state: 'ready' };
      return {
        state: building.status === 'ready' ? 'ready' : 'building',
        ...(typeof building.initial === 'number' ? { initial: building.initial } : {}),
        ...(typeof building.pending === 'number' ? { pending: building.pending } : {}),
      };
    } catch (e) {
      this.logger.warn(`hnsw probe failed for ${spec.index}: ${(e as Error).message}`);
      return { state: 'unknown' };
    }
  }
}
