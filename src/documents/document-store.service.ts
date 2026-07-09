import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Surreal } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
} from '../db/surreal.service';
import { idTailOf, redactPii } from '../ingest/ingest-utils';
import { MetricsService } from '../metrics/metrics.service';
import { chunkDocument, DocumentChunk } from './chunker';
import { IngestDocumentDto } from './dto/ingest-document.dto';

/** Header row of a stored document, as the rest of the pipeline sees it. */
export interface StoredDocument {
  id: string;
  kind: string;
  contentHash: string;
  charLen: number;
  chunkCount: number;
  hasContent: boolean;
  vertical: string;
  recorder?: string;
  occurredAt: Date;
  status: string;
}

export interface CreateDocumentResult {
  doc: StoredDocument;
  /**
   * Chunks computed from THIS request's text (in memory, deterministic) —
   * available for indexing even when storeContent=false persisted nothing.
   */
  chunks: DocumentChunk[];
  deduplicated: boolean;
}

/**
 * The Source layer: normalized-document persistence (migration 0048).
 * Owns redaction → hashing → chunking → dedupe-by-contentHash. Knows
 * nothing about indexers or candidates — it stores what a connector read.
 */
@Injectable()
export class DocumentStoreService {
  private readonly logger = new Logger(DocumentStoreService.name);

  constructor(
    private readonly surreal: SurrealService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Create the document (header + chunks), or return the existing one when
   * the same normalized text was already ingested (UNIQUE contentHash).
   * PII redaction runs BEFORE hashing, so idempotency is over the stored
   * form (hash shifts only when the redactor itself changes — per-deploy,
   * acceptable).
   */
  async createOrGet(
    companyId: string,
    dto: IngestDocumentDto,
  ): Promise<CreateDocumentResult> {
    const text = redactPii(dto.text).trim();
    const contentHash = sha256Hex(text);
    const chunks = chunkDocument(text, {
      targetChars: envInt('DOC_CHUNK_TARGET_CHARS', 12_000),
    });
    const storeContent = dto.storeContent !== false;

    return this.surreal.withCompany(companyId, async (db) => {
      try {
        const row = await dbCreate<Record<string, unknown>>(db, 'source_document', {
          kind: dto.kind,
          originUri: dto.originUri,
          title: dto.title,
          contentHash,
          charLen: text.length,
          chunkCount: chunks.length,
          hasContent: storeContent,
          vertical: dto.contextRef.vertical,
          recorder: dto.contextRef.recorder,
          occurredAt: new Date(dto.occurredAt),
          meta: dto.meta,
          status: 'received',
        });
        const docId = String(row.id);
        if (storeContent) {
          for (const c of chunks) {
            await db.query(
              `CREATE source_chunk CONTENT {
                 docId: type::record('source_document', $doc),
                 seq: $seq, text: $text, charStart: $start, charEnd: $end
               }`,
              {
                doc: idTailOf(docId),
                seq: c.seq,
                text: c.text,
                start: c.charStart,
                end: c.charEnd,
              },
            );
          }
        }
        this.metrics?.countDocument('created');
        return { doc: mapDoc({ ...row, id: docId }), chunks, deduplicated: false };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await this.byContentHash(db, contentHash);
        if (!existing) throw err;
        this.logger.log(
          `document dedupe hit contentHash=${contentHash.slice(0, 12)}… doc=${existing.id}`,
        );
        this.metrics?.countDocument('deduplicated');
        return { doc: existing, chunks, deduplicated: true };
      }
    });
  }

  async getById(companyId: string, docId: string): Promise<StoredDocument | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT * FROM type::record('source_document', $id)`,
        { id: idTailOf(docId) },
      );
      const row = ((rows as any[]) ?? [])[0];
      return row ? mapDoc(row) : null;
    });
  }

  /** Stored chunks (empty for hasContent=false documents). */
  async getChunks(companyId: string, docId: string): Promise<DocumentChunk[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT seq, text, charStart, charEnd FROM source_chunk
         WHERE docId = type::record('source_document', $id) ORDER BY seq ASC`,
        { id: idTailOf(docId) },
      );
      return (((rows as any[]) ?? []) as DocumentChunk[]).map((r) => ({
        seq: r.seq,
        text: r.text,
        charStart: r.charStart,
        charEnd: r.charEnd,
      }));
    });
  }

  async setStatus(p: {
    companyId: string;
    docId: string;
    status: string;
  }): Promise<void> {
    await this.surreal.withCompany(p.companyId, async (db) => {
      await db.query(
        `UPDATE type::record('source_document', $id) SET status = $status`,
        { id: idTailOf(p.docId), status: p.status },
      );
    });
  }

  /**
   * Explicit erasure: delete the chunk rows, keep the header + contentHash
   * (re-ingest of the same text still dedupes; committed facts keep a
   * resolvable documentId pointer).
   */
  async purgeContent(companyId: string, docId: string): Promise<boolean> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT id FROM type::record('source_document', $id)`,
        { id: idTailOf(docId) },
      );
      if (!((rows as any[]) ?? [])[0]) return false;
      await db.query(
        `DELETE source_chunk WHERE docId = type::record('source_document', $id)`,
        { id: idTailOf(docId) },
      );
      await db.query(
        `UPDATE type::record('source_document', $id)
           SET status = 'purged', hasContent = false`,
        { id: idTailOf(docId) },
      );
      return true;
    });
  }

  private async byContentHash(
    db: Surreal,
    contentHash: string,
  ): Promise<StoredDocument | null> {
    const [rows] = await db.query<[any[]]>(
      `SELECT * FROM source_document WHERE contentHash = $h LIMIT 1`,
      { h: contentHash },
    );
    const row = ((rows as any[]) ?? [])[0];
    return row ? mapDoc(row) : null;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 'doc:' + contentHash — the origin identity migration 0050 keys on. */
export function originKeyOf(contentHash: string): string {
  return `doc:${contentHash}`;
}

function mapDoc(row: Record<string, unknown>): StoredDocument {
  return {
    id: String(row.id),
    kind: String(row.kind),
    contentHash: String(row.contentHash),
    charLen: Number(row.charLen),
    chunkCount: Number(row.chunkCount),
    hasContent: Boolean(row.hasContent),
    vertical: String(row.vertical),
    recorder: row.recorder ? String(row.recorder) : undefined,
    occurredAt: new Date(row.occurredAt as string | Date),
    status: String(row.status),
  };
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
