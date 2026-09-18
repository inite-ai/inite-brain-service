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
 *           and still active — or corroborating one that is (a later
 *           render of the same record re-asserting a value) — are
 *           touched, on every document the item produced.
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
      for (const docId of await this.documentsOf(companyId, item)) {
        closed += await this.closeDocumentFacts(companyId, docId, goneAt);
      }
    }
    return closed;
  }

  /**
   * The inverse, for an item that was gone and is seen again with
   * byte-identical content (the document deduplicates, so no new facts
   * are made): the facts `apply` closed at exactly `goneAt` reopen. Only
   * that instant's closes — a fact whose validity ended for a reason of
   * its own keeps its end. Returns the number reopened.
   */
  async reopen(
    companyId: string,
    connection: SourceConnectionRow,
    item: {
      id: unknown;
      documentId?: string | null | undefined;
      assetId?: string | null | undefined;
      goneAt: Date;
    },
  ): Promise<number> {
    if (connection.deletePolicy === 'keep') return 0;
    let reopened = 0;
    for (const docId of await this.documentsOf(companyId, item)) {
      reopened += await this.reopenDocumentFacts(companyId, docId, item.goneAt);
    }
    if (reopened > 0) {
      this.logger.log(
        `${String(connection.id)}: ${reopened} fact(s) reopened — the item is back unchanged`,
      );
    }
    return reopened;
  }

  /**
   * Every document an item's facts may sit on: the one it is linked to
   * now, the earlier revisions' documents (a fact first asserted by an
   * older render stays grounded there while later renders only
   * corroborate it — `meta.sourceItemId` names them all), and, for a
   * binary item, the documents the bridge made of its asset
   * (meta.evidenceAssetId). Bounded and best-effort: a scan that times
   * out leaves the linked document alone in the list.
   */
  private async documentsOf(
    companyId: string,
    item: {
      id: unknown;
      documentId?: string | null | undefined;
      assetId?: string | null | undefined;
    },
  ): Promise<string[]> {
    const out = new Set<string>();
    if (item.documentId) out.add(item.documentId);
    if (item.assetId) {
      for (const docId of await this.bridgedDocuments(companyId, item.assetId)) out.add(docId);
    }
    for (const docId of await this.revisionDocuments(companyId, String(item.id))) out.add(docId);
    return [...out];
  }

  private async revisionDocuments(companyId: string, itemId: string): Promise<string[]> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const rows = await queryRows<{ id: unknown }>(
          db,
          `SELECT id FROM source_document WHERE meta.sourceItemId = $itemId LIMIT 200 TIMEOUT 5s`,
          { itemId },
        );
        return rows.map((r) => String(r.id));
      });
    } catch (e) {
      this.logger.warn(`documents of ${itemId} not listed: ${(e as Error).message}`);
      return [];
    }
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
          `SELECT id FROM knowledge_fact WHERE source.documentId = $docId AND status IN ['active', 'corroborating'] AND validUntil IS NONE LIMIT 200`,
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

  private async reopenDocumentFacts(
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
          `SELECT id FROM knowledge_fact WHERE source.documentId = $docId AND status IN ['active', 'corroborating'] AND validUntil = $at LIMIT 200`,
          { docId, at },
        );
        if (rows.length === 0) break;
        await db.query(`UPDATE $ids SET validUntil = NONE`, { ids: rows.map((r) => r.id) });
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
