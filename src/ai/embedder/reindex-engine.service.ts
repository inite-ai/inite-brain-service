import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SurrealService } from '../../db/surreal.service';
import { EmbedderService } from '../embedder.service';

interface FactRowForReindex {
  id: { tb: string; id: { String: string } } | string;
  predicate: string;
  object: string;
}

/**
 * ReindexEngineService — the per-tenant re-embed engine.
 *
 * Owns the "how to reindex ONE tenant" mechanics (pagination, batched
 * embedMany, row updates) plus the active embedder provider id. The
 * tenant-iteration / orchestration lives in ReindexEmbeddingsService,
 * which delegates here. Splitting the engine out keeps each class's
 * injected-dep list ≤3 and isolates the DB/embedder machinery from the
 * "which tenants" policy.
 */
@Injectable()
export class ReindexEngineService {
  private readonly logger = new Logger(ReindexEngineService.name);
  private readonly batchSize: number;

  constructor(
    private readonly surreal: SurrealService,
    private readonly embedder: EmbedderService,
    config: ConfigService,
  ) {
    this.batchSize = parseInt(
      config.get<string>('REINDEX_BATCH_SIZE', '200'),
      10,
    );
  }

  /**
   * The active embedder provider id, surfaced in the response for
   * operator audit. The stub embedder used in tests doesn't implement
   * cacheStats, so we fall back to 'unknown' instead of crashing.
   */
  providerId(): string {
    return typeof this.embedder.cacheStats === 'function'
      ? this.embedder.cacheStats().provider
      : 'unknown';
  }

  async reindexTenant(
    companyId: string,
    opts: { dryRun: boolean; remaining: number },
  ): Promise<{ factsScanned: number; factsUpdated: number }> {
    return this.surreal.withCompany(companyId, async (db) => {
      let offset = 0;
      let factsScanned = 0;
      let factsUpdated = 0;
      const batch = Math.min(this.batchSize, opts.remaining);
      // Paginate until either the tenant is empty or we hit the cap.
      while (factsScanned < opts.remaining) {
        const [rows] = await db.query<[FactRowForReindex[]]>(
          `SELECT id, predicate, object
              FROM knowledge_fact
              ORDER BY id
              LIMIT $batch START $offset`,
          { batch, offset },
        );
        const page = (rows as FactRowForReindex[]) ?? [];
        if (page.length === 0) break;

        factsScanned += page.length;
        if (!opts.dryRun) {
          // Batch the whole page through one embedMany — the previous
          // per-row embed() loop paid one HTTP round-trip per fact,
          // which made reindex unworkable on large tenants (a 100k-row
          // tenant = 100k sequential calls). embedMany chunks 512 at
          // a time inside the OpenAI provider.
          const texts = page.map((row) => `${row.predicate}: ${row.object}`);
          let embeddings: number[][];
          try {
            embeddings = await this.embedder.embedMany(texts);
          } catch (e) {
            this.logger.warn(
              `reindex batch embed failed (${companyId}, page=${page.length}): ${(e as Error).message}`,
            );
            // Skip this page entirely; the next outer-loop iteration
            // advances `offset` by `page.length` so we don't retry-loop.
            offset += page.length;
            if (page.length < batch) break;
            continue;
          }
          for (let i = 0; i < page.length; i++) {
            try {
              await db.query(`UPDATE $id SET embedding = $embedding`, {
                id: page[i].id,
                embedding: embeddings[i],
              });
              factsUpdated += 1;
            } catch (e) {
              this.logger.warn(
                `reindex row update failed (${companyId}): ${(e as Error).message}`,
              );
            }
          }
        }
        offset += page.length;
        if (page.length < batch) break;
      }
      return { factsScanned, factsUpdated };
    });
  }
}
