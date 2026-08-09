import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';

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
 * Embedder swap (dimension change) — STRICT order, or the tenant's
 * writes stall. The dimension is baked into the index DDL, and once an
 * index exists every ingest/upsert of a differently-sized vector is
 * rejected, which ALSO blocks the reindex that would fix it. Recover in
 * this order (each step is a separate admin call):
 *
 *   a. {action:'drop'}        — remove the old-dimension indexes;
 *   b. reindex embeddings     — rewrite every vector at the new size
 *      (POST /v1/admin/maintenance/reindex-embeddings), now unblocked;
 *   c. {action:'create'}      — build fresh indexes at the new size.
 *
 * segment_embedding_hnsw (the coverage-scan leg, V11 §5) has a swap
 * caveat: reindex-embeddings rewrites knowledge_fact ONLY — segments
 * keep their old-size vectors. Segments are derived state (0075), so
 * the segment step of a swap is drop → delete + re-segment the world →
 * create; entity_embedding_hnsw shares the same hole and today relies
 * on entity vectors being rewritten by their own ingest path.
 *
 * `create` guards this: DEFINE INDEX IF NOT EXISTS SILENTLY NO-OPS when
 * an index already exists at a different dimension (verified on 3.1.5),
 * so a naive re-`create` after a swap would report success while leaving
 * the stale index in place. We detect the mismatch and refuse, pointing
 * the operator at the drop→reindex→create order above.
 *
 * DEFINE INDEX is synchronous — on a large tenant the call can take a
 * while; run it off-peak.
 */
export interface HnswMaintenanceResult {
  companyId: string;
  action: 'create' | 'drop';
  dimension: number;
  indexes: string[];
}

const FACT_MAIN = 'fact_embedding_hnsw';
const FACT_ALT = 'fact_alt_embedding_hnsw';
const ENTITY_MAIN = 'entity_embedding_hnsw';
const SEGMENT_MAIN = 'segment_embedding_hnsw';

@Injectable()
export class HnswMaintenanceService {
  private readonly logger = new Logger(HnswMaintenanceService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
  ) {}

  async apply(
    companyId: string,
    action: 'create' | 'drop',
  ): Promise<HnswMaintenanceResult> {
    const dimension = this.embedder.getDimensions();
    if (!Number.isInteger(dimension) || dimension < 8 || dimension > 8192) {
      throw new BadRequestException(
        `embedder reports implausible dimension ${dimension}`,
      );
    }
    return this.surreal.withCompany(companyId, async (db) => {
      if (action === 'create') {
        // Refuse a create that would SILENTLY leave a stale-dimension
        // index in place (IF NOT EXISTS no-ops on a dimension change).
        await this.assertNoDimensionMismatch(db, dimension);
        // DIMENSION can't be parameterised in DDL — `dimension` is a
        // validated integer, never caller input.
        await db.query(
          `DEFINE INDEX IF NOT EXISTS ${FACT_MAIN} ON knowledge_fact FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX IF NOT EXISTS ${FACT_ALT} ON knowledge_fact FIELDS altEmbedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX IF NOT EXISTS ${ENTITY_MAIN} ON knowledge_entity FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX IF NOT EXISTS ${SEGMENT_MAIN} ON episode_segment FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;`,
        );
      } else {
        await db.query(
          `REMOVE INDEX IF EXISTS ${FACT_MAIN} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${FACT_ALT} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${ENTITY_MAIN} ON knowledge_entity;
           REMOVE INDEX IF EXISTS ${SEGMENT_MAIN} ON episode_segment;`,
        );
      }
      this.logger.log(
        `hnsw ${action} for ${companyId} (dimension=${dimension})`,
      );
      return {
        companyId,
        action,
        dimension,
        indexes: [FACT_MAIN, FACT_ALT, ENTITY_MAIN, SEGMENT_MAIN],
      };
    });
  }

  /**
   * Throw if any target HNSW index already exists at a dimension other
   * than `dimension`. Without this, DEFINE INDEX IF NOT EXISTS reports
   * success but leaves the old-dimension index untouched (empirically
   * confirmed on SurrealDB 3.1.5).
   */
  private async assertNoDimensionMismatch(
    db: Surreal,
    dimension: number,
  ): Promise<void> {
    const existing = await this.readIndexDimensions(db);
    const mismatched = [FACT_MAIN, FACT_ALT, ENTITY_MAIN, SEGMENT_MAIN].filter(
      (name) => existing.has(name) && existing.get(name) !== dimension,
    );
    if (mismatched.length > 0) {
      const detail = mismatched
        .map((n) => `${n}=${existing.get(n)}`)
        .join(', ');
      throw new BadRequestException(
        `HNSW index(es) [${detail}] already exist at a different dimension; ` +
          `the embedder now reports ${dimension}. DEFINE INDEX IF NOT EXISTS ` +
          `silently no-ops on a dimension change, so this create would leave ` +
          `the stale index in place. Recover in order: drop → reindex ` +
          `embeddings → create.`,
      );
    }
  }

  /** Map of HNSW index name → its declared DIMENSION, parsed from INFO. */
  private async readIndexDimensions(db: Surreal): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const table of [
      'knowledge_fact',
      'knowledge_entity',
      'episode_segment',
    ]) {
      const [info] = await db.query<[{ indexes?: Record<string, string> }]>(
        `INFO FOR TABLE ${table};`,
      );
      const indexes =
        (info as { indexes?: Record<string, string> })?.indexes ?? {};
      for (const [name, ddl] of Object.entries(indexes)) {
        const m = /DIMENSION\s+(\d+)/i.exec(String(ddl));
        if (m) out.set(name, parseInt(m[1], 10));
      }
    }
    return out;
  }
}
