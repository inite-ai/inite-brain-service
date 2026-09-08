import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
 * Embedder swap (dimension change). The width is baked into the index
 * DDL, and once an index exists every write of a differently-sized
 * vector is rejected — which ALSO blocks the reindex that would fix it.
 * `create` therefore RECREATES unconditionally: it removes each index
 * and defines it again at the declared width, in one statement.
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

  async apply(companyId: string, action: 'create' | 'drop'): Promise<HnswMaintenanceResult> {
    // PRIMARY, not active: getDimensions() reports whoever is serving, so
    // an index build triggered during the bge-m3 warmup window would bake
    // the OpenAI fallback's 1536 into DDL for a 1024 corpus — an index the
    // primary can never write to once warm.
    const dimension = this.embedder.primaryDimensions();
    if (!Number.isInteger(dimension) || dimension < 8 || dimension > 8192) {
      throw new BadRequestException(`embedder reports implausible dimension ${dimension}`);
    }
    return this.surreal.withCompany(companyId, async (db) => {
      if (action === 'create') {
        // RECREATE, not create-if-absent: REMOVE then DEFINE, so the
        // index always ends at the declared width. `IF NOT EXISTS` alone
        // silently no-ops on a width change and would leave a stale
        // index while reporting success. DIMENSION cannot be
        // parameterised in DDL — `dimension` comes from the space
        // declaration and is range-validated above, never caller input.
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
      } else {
        await db.query(
          `REMOVE INDEX IF EXISTS ${FACT_MAIN} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${FACT_ALT} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${ENTITY_MAIN} ON knowledge_entity;
           REMOVE INDEX IF EXISTS ${SEGMENT_MAIN} ON episode_segment;`,
        );
      }
      this.logger.log(`hnsw ${action} for ${companyId} (dimension=${dimension})`);
      return {
        companyId,
        action,
        dimension,
        indexes: [FACT_MAIN, FACT_ALT, ENTITY_MAIN, SEGMENT_MAIN],
      };
    });
  }
}
