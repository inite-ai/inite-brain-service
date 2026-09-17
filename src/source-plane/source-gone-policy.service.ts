import { Injectable, Logger } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { idTailOf } from '../ingest/ingest-utils';
import type { SourceConnectionRow } from './source-connection.service';
import type { SourceItemRow } from './source-item.service';

/**
 * SourceGonePolicyService — what happens to the facts an item grounded
 * when the source reports the item gone (raw-evidence-sources doctrine
 * 6: "drift and deletion are bitemporal events").
 *
 *   close   (default) — the facts stay believed for their interval and
 *           get `validUntil = goneAt`: a deleted file is history, not a
 *           lie. Only facts that are still open (`validUntil IS NONE`)
 *           and still active are touched.
 *   retract — reserved: the cascade-retract path lands with the first
 *             native that can observe deletions reliably (W1); today it
 *             behaves as `close` and says so in the log.
 *   keep    — mark the catalogue row only; the facts are untouched.
 *
 * SurrealDB 3.2.4 discipline: SELECT the ids, then UPDATE $ids — never
 * `UPDATE … WHERE` over an indexed field (the silent planner no-op).
 */
@Injectable()
export class SourceGonePolicyService {
  private readonly logger = new Logger(SourceGonePolicyService.name);

  constructor(private readonly surreal: SurrealService) {}

  /** Returns the number of facts closed. */
  async apply(
    companyId: string,
    connection: SourceConnectionRow,
    gone: SourceItemRow[],
  ): Promise<number> {
    if (connection.deletePolicy === 'keep') return 0;
    if (connection.deletePolicy === 'retract') {
      this.logger.log(
        `deletePolicy 'retract' on ${String(connection.id)} closes validity (retract cascade: W1)`,
      );
    }
    let closed = 0;
    for (const item of gone) {
      const goneAt = asDate(item.goneAt) ?? new Date();
      if (item.documentId) {
        closed += await this.closeDocumentFacts(companyId, item.documentId, goneAt);
      } else if (item.assetId) {
        // A binary item's facts live on the documents the bridge made of
        // its asset (meta.evidenceAssetId) — each closes like a text item's.
        for (const docId of await this.bridgedDocuments(companyId, item.assetId)) {
          closed += await this.closeDocumentFacts(companyId, docId, goneAt);
        }
      }
    }
    return closed;
  }

  private async bridgedDocuments(companyId: string, assetId: string): Promise<string[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const tail = idTailOf(assetId);
      const rows = await queryRows<{ id: unknown }>(
        db,
        `SELECT id FROM source_document WHERE meta.evidenceAssetId IN $ids LIMIT 100`,
        { ids: [assetId, `evidence_asset:${tail}`] },
      );
      return rows.map((r) => String(r.id));
    });
  }

  private async closeDocumentFacts(
    companyId: string,
    documentId: string,
    at: Date,
  ): Promise<number> {
    return this.surreal.withCompany(companyId, async (db) => {
      const docId = `source_document:${idTailOf(documentId)}`;
      let total = 0;
      for (;;) {
        const rows = await queryRows<{ id: unknown }>(
          db,
          `SELECT id FROM knowledge_fact WHERE source.documentId = $docId AND status = 'active' AND validUntil IS NONE LIMIT 200`,
          { docId },
        );
        if (rows.length === 0) break;
        await db.query(`UPDATE $ids SET validUntil = $at`, { ids: rows.map((r) => r.id), at });
        total += rows.length;
        if (rows.length < 200) break;
      }
      return total;
    });
  }
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}
