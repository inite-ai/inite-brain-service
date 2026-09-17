import { Injectable, Logger, Optional } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { EmbedderService } from '../ai/embedder.service';
import { nameKeysFor } from '../common/name-key';

/**
 * Backfill of the two per-entity name derivatives on existing rows
 * (POST /v1/admin/maintenance/entities/backfill-name-keys):
 *
 *   - `nameKeys` (0148): the transliteration of every spelling the
 *     entity is known by — what lets "Иван Петров" find the entity
 *     ingested as "Ivan Petrov" without asking an LLM.
 *   - `embedding`: the entity's name by meaning (a column the 0001
 *     baseline defined and nothing ever wrote) — what the
 *     inline resolver and the dreams dedup scan for a name rendered by
 *     SOUND in another script.
 *
 * WHY THIS IS NEEDED AT ALL. Both are computed in JS — SurrealDB has no
 * transliteration function and no embedder — so unlike `canonicalNameLc`
 * neither can be a VALUE field the migration fills in. Rows written
 * before 0148 carry none, and for those rows the cross-script step
 * and the embedding scans find nothing and behave exactly as they did
 * before. Nothing breaks; the capability is simply absent until this
 * runs.
 *
 * WHY IT IS NOT URGENT. The ingest path stamps keys onto any entity it
 * reuses deterministically, so an active corpus heals its keys one
 * mention at a time. This endpoint is for doing it at once, for the long
 * tail of entities nobody mentions again, and for the embeddings, which
 * the ingest path only writes at creation.
 *
 * Idempotent: the cursor is `nameKeys IS NONE`. A row whose names yield
 * no key at all (a name made entirely of punctuation or emoji — see
 * name-key.ts on why those get none) is stamped with an empty array so
 * the scan does not return to it forever. The embedding is written for
 * every row in the same pass when an embedder is wired; a row that
 * already has keys but no embedding (created before this backfill embedded) is
 * picked up by the second cursor below.
 *
 * 3.2.4 planner idiom, same as segment-backfill: page with a plain
 * option-field WHERE, and address every UPDATE by PRIMARY KEY
 * (`UPDATE $id SET …`) rather than by a WHERE over an indexed field.
 */
const PAGE_SIZE = 200;
const DEFAULT_MAX_ROWS = 5000;
const MAX_ROWS_CAP = 200000;

export interface NameKeyBackfillResult {
  scanned: number;
  updated: number;
  /** Rows whose names produced no usable key; stamped `[]` and not revisited. */
  keyless: number;
  /** Rows that received a name embedding in this pass. */
  embedded: number;
  remaining: number;
}

interface EntityPageRow {
  id: unknown;
  canonicalName?: string | undefined;
  aliases?: string[] | undefined;
}

@Injectable()
export class NameKeyBackfillService {
  private readonly logger = new Logger(NameKeyBackfillService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly embedder?: EmbedderService,
  ) {}

  async run(companyId: string, maxRows = DEFAULT_MAX_ROWS): Promise<NameKeyBackfillResult> {
    const budget = Math.min(Math.max(1, Math.trunc(maxRows)), MAX_ROWS_CAP);
    let scanned = 0;
    let updated = 0;
    let keyless = 0;
    let embedded = 0;

    await this.surreal.withCompany(companyId, async (db) => {
      // Two cursors, same page loop: rows with no keys at all, then rows
      // that have keys but no embedding yet.
      const cursors = ['nameKeys IS NONE', 'nameKeys != NONE AND embedding IS NONE'];
      for (const cursor of cursors) {
        if (cursor.includes('embedding') && !this.embedder) break;
        while (scanned < budget) {
          const [rows] = await db.query<[EntityPageRow[]]>(
            `SELECT id, canonicalName, aliases FROM knowledge_entity
               WHERE ${cursor}
               LIMIT $limit`,
            { limit: Math.min(PAGE_SIZE, budget - scanned) },
          );
          const page = rows ?? [];
          if (page.length === 0) break;

          const vectors = await this.embedPage(page);
          for (const [i, row] of page.entries()) {
            scanned++;
            const keys = nameKeysFor([row.canonicalName, ...(row.aliases ?? [])]);
            if (keys.length === 0) keyless++;
            const vector = vectors[i];
            if (vector) embedded++;
            // Stamped even when the keys are empty: `nameKeys IS NONE` is
            // the scan's cursor, so a row left unstamped is a row the next
            // page returns again, forever.
            await db.query(
              vector
                ? `UPDATE $id SET nameKeys = $keys, embedding = $vector, embeddingSpaceId = $space`
                : `UPDATE $id SET nameKeys = $keys`,
              {
                id: new StringRecordId(String(row.id)),
                keys,
                vector,
                space: this.embedder?.activeSpaceId(),
              },
            );
            updated++;
          }
          if (page.length < PAGE_SIZE) break;
        }
      }
    });

    const remaining = await this.countRemaining(companyId);
    this.logger.log(
      `[admin.name_keys] ${companyId}: scanned=${scanned} updated=${updated} ` +
        `keyless=${keyless} embedded=${embedded} remaining=${remaining}`,
    );
    return { scanned, updated, keyless, embedded, remaining };
  }

  /**
   * One name embedding per row of the page, or an empty array when there
   * is no embedder or the space guard refuses (primary still warming up).
   * A page that cannot be embedded still gets its keys — the two
   * derivatives are independent and the second cursor returns for the
   * embeddings later.
   */
  private async embedPage(page: EntityPageRow[]): Promise<Array<number[] | undefined>> {
    if (!this.embedder) return [];
    const texts = page.map((r) => `name: ${r.canonicalName ?? ''}`);
    try {
      return await this.embedder.embedManyForWrite(texts);
    } catch (err) {
      this.logger.warn(
        `[admin.name_keys] page of ${page.length} left without embeddings: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private async countRemaining(companyId: string): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ n: number }>]>(
        `SELECT count() AS n FROM knowledge_entity
          WHERE nameKeys IS NONE OR embedding IS NONE
          GROUP ALL`,
      );
      return rows?.[0]?.n ?? 0;
    });
  }
}
