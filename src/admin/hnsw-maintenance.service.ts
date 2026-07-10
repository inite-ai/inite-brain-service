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
 *   1. (if the embedder ever changed) run the embedding reindex first —
 *      the index build fails on rows whose vector length disagrees;
 *   2. POST /v1/admin/maintenance/hnsw {action:'create'} per tenant;
 *   3. flip SEARCH_HNSW_ENABLED=1 — the KNN leg kicks in, and tenants
 *      without indexes soft-fall back to the full scan;
 *   4. re-run the quality eval — filtered KNN is approximate; the
 *      over-fetch knob (SEARCH_HNSW_OVERFETCH) trades recall for speed.
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
        // DIMENSION can't be parameterised in DDL — `dimension` is a
        // validated integer, never caller input.
        await db.query(
          `DEFINE INDEX IF NOT EXISTS ${FACT_MAIN} ON knowledge_fact FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX IF NOT EXISTS ${FACT_ALT} ON knowledge_fact FIELDS altEmbedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;
           DEFINE INDEX IF NOT EXISTS ${ENTITY_MAIN} ON knowledge_entity FIELDS embedding
             HNSW DIMENSION ${dimension} DIST COSINE EFC 200 M 16;`,
        );
      } else {
        await db.query(
          `REMOVE INDEX IF EXISTS ${FACT_MAIN} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${FACT_ALT} ON knowledge_fact;
           REMOVE INDEX IF EXISTS ${ENTITY_MAIN} ON knowledge_entity;`,
        );
      }
      this.logger.log(
        `hnsw ${action} for ${companyId} (dimension=${dimension})`,
      );
      return {
        companyId,
        action,
        dimension,
        indexes: [FACT_MAIN, FACT_ALT, ENTITY_MAIN],
      };
    });
  }
}
