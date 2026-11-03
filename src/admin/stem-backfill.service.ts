import { Injectable, Logger } from '@nestjs/common';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';

/**
 * Backfill of the stemmed shadow fields (0184, #892) on rows written
 * before them (POST /v1/admin/maintenance/backfill-stems).
 *
 * The database computes the stems itself (a VALUE field), but a VALUE
 * only fires on a write, so a row nobody has written since keeps NONE and
 * is matched only by its unstemmed index, exactly as before 0184. Touching
 * it — `UPDATE $id SET <field> = NONE`, which the VALUE overrides — is
 * the whole backfill. No model, no embedding.
 *
 * Idempotent: the cursor is `<field> IS NONE`, and a row whose language
 * has no analyzer stores '' (0184), so the scan never returns to it. Paged
 * and addressed by primary key, the 3.2.4 planner idiom of
 * name-key-backfill.service.ts. Neither table's events fire on it: both
 * fact events are guarded on a status change.
 */
const PAGE_SIZE = 200;
const DEFAULT_MAX_ROWS = 5000;
const MAX_ROWS_CAP = 200000;

/** Each stemmed shadow field 0184 defines, with its table. */
const STEMMED = [
  { table: 'knowledge_fact', field: 'haystackStem' },
  { table: 'episode', field: 'textStem' },
] as const;

export interface StemBackfillResult {
  updated: Record<string, number>;
  remaining: Record<string, number>;
}

@Injectable()
export class StemBackfillService {
  private readonly logger = new Logger(StemBackfillService.name);

  constructor(private readonly surreal: SurrealService) {}

  async run(companyId: string, maxRows = DEFAULT_MAX_ROWS): Promise<StemBackfillResult> {
    let budget = Math.min(Math.max(1, Math.trunc(maxRows)), MAX_ROWS_CAP);
    const updated: Record<string, number> = {};
    const remaining: Record<string, number> = {};
    await this.surreal.withCompany(companyId, async (db) => {
      for (const { table, field } of STEMMED) {
        updated[table] = 0;
        while (budget > 0) {
          const [rows] = await db.query<[Array<{ id: unknown }>]>(
            `SELECT id FROM type::table($table) WHERE ${field} IS NONE LIMIT $limit`,
            { table, limit: Math.min(PAGE_SIZE, budget) },
          );
          const page = rows ?? [];
          for (const row of page) {
            await db.query(`UPDATE $id SET ${field} = NONE`, {
              id: new StringRecordId(String(row.id)),
            });
          }
          updated[table] += page.length;
          budget -= page.length;
          if (page.length < PAGE_SIZE) break;
        }
        const [left] = await db.query<[Array<{ n: number }>]>(
          `SELECT count() AS n FROM type::table($table) WHERE ${field} IS NONE GROUP ALL`,
          { table },
        );
        remaining[table] = left?.[0]?.n ?? 0;
      }
    });
    this.logger.log(
      `[admin.stems] ${companyId}: updated=${JSON.stringify(updated)} remaining=${JSON.stringify(remaining)}`,
    );
    return { updated, remaining };
  }
}
