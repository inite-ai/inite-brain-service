import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SurrealService, queryRows } from '../db/surreal.service';
import { StringRecordId } from 'surrealdb';
import { DocumentStoreService } from './document-store.service';
import { CommitWriterService, episodeForSpans } from './commit-writer.service';
import { idTailOf } from '../ingest/ingest-utils';

export interface RawTurnsBackfillResult {
  companyId: string;
  /** Documents with content and no raw turns yet. */
  documents: number;
  /** Turns captured across them. */
  turns: number;
  /** Facts newly pointed at the turn their value sits in. */
  factsStamped: number;
}

/** Documents one pass takes on; the next process start continues where it stopped. */
const DOCS_PER_PASS = 500;

/**
 * Gives the documents stored before #676 the raw turns every document
 * now keeps at commit, and points their facts at them.
 *
 * Until then a document posted through ingest_document captured no L0
 * turn and its facts named none, so every raw read lane — excerpts, raw
 * windows, grounding quotes, the episodic lane, L3 sessions — read
 * nothing for them. A commit now captures them (CommitWriterService
 * .captureTurns); this pass does the same for what is already stored,
 * without re-extracting anything: the stored chunks are cut into turns
 * and captured through the same path, and each fact of the document that
 * names no turn gets the one its value sits in. A fact whose value is in
 * no turn stays as it was — a guessed turn would be a false quote.
 *
 * Idempotent: a document whose conversation already holds turns is
 * skipped, captureTurn is unique on (conversation, turn), and only facts
 * without episodeIds are stamped. Runs once per (process, tenant) off the
 * schema-ready hook, like the entity consolidation pass.
 */
@Injectable()
export class RawTurnsBackfillService implements OnModuleInit {
  private readonly logger = new Logger(RawTurnsBackfillService.name);
  private readonly pending = new Set<string>();
  private readonly seen = new Set<string>();
  private draining = false;

  constructor(
    private readonly surreal: SurrealService,
    private readonly store: DocumentStoreService,
    private readonly writer: CommitWriterService,
  ) {}

  onModuleInit(): void {
    this.surreal.onTenantSchemaReady((companyId) => this.noteTenant(companyId));
  }

  /** The hook body — allocation only; the work runs off the request path. */
  noteTenant(companyId: string): void {
    if (this.seen.has(companyId) || this.pending.has(companyId)) return;
    this.pending.add(companyId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const companyId of this.pending) {
        this.pending.delete(companyId);
        this.seen.add(companyId);
        try {
          const r = await this.backfill(companyId);
          if (r.documents > 0) {
            this.logger.log(
              `[documents.raw_turns] ${companyId}: ${r.documents} document(s) — ${r.turns} turns, ${r.factsStamped} facts pointed at their turn`,
            );
          }
        } catch (err) {
          this.logger.warn(`[documents.raw_turns] ${companyId} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async backfill(companyId: string): Promise<RawTurnsBackfillResult> {
    const result: RawTurnsBackfillResult = { companyId, documents: 0, turns: 0, factsStamped: 0 };
    await this.surreal.withCompany(companyId, async (db) => {
      const ids = await queryRows<unknown>(
        db,
        `SELECT VALUE id FROM source_document WHERE hasContent = true ORDER BY id LIMIT $n`,
        { n: DOCS_PER_PASS },
      );
      for (const rid of ids) {
        const docId = String(rid);
        const conv = `document:${idTailOf(docId)}`;
        const [held] = await db.query<[number[]]>(
          `SELECT VALUE count() FROM episode WHERE conversationId = $conv GROUP ALL`,
          { conv },
        );
        if ((held?.[0] ?? 0) > 0) continue;
        const doc = await this.store.getById(companyId, docId);
        if (!doc) continue;
        const captured = await this.writer.captureTurns(db, companyId, doc);
        if (!captured) continue;
        result.documents += 1;
        result.turns += captured.ids.filter((id) => id !== null).length;
        const facts = await queryRows<{ id: unknown; object: unknown }>(
          db,
          `SELECT id, object FROM knowledge_fact
             WHERE source.documentId = $doc AND source.episodeIds IS NONE`,
          { doc: docId },
        );
        for (const f of facts) {
          const episodeId = episodeForSpans(captured, [String(f.object)]);
          if (!episodeId) continue;
          await db.query(`UPDATE $id SET source.episodeIds = [$ep]`, {
            id: new StringRecordId(String(f.id)),
            ep: episodeId,
          });
          result.factsStamped += 1;
        }
      }
    });
    return result;
  }
}
