import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
} from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { sanitizeSourceMeta } from '../policy/source-meta';
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
  /**
   * Operator-supplied document metadata (IngestDocumentDto.meta).
   * Projected onto derived facts' `source.meta` by the commit writer
   * (sanitized) so ABAC source rules can match it — the Zep-style
   * episode-metadata projection.
   */
  meta?: Record<string, unknown>;
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
    // Meta becomes ABAC-matchable `source.meta` on every derived fact
    // (commit-writer projection), so it must be operator vocabulary.
    // Default: sanitize-and-warn; SOURCE_META_STRICT=1 rejects instead —
    // a silently-dropped data_class would silently widen access.
    if (dto.meta !== undefined) {
      const { dropped } = sanitizeSourceMeta(dto.meta);
      if (dropped.length > 0) {
        if (envFlagEnabled(process.env.SOURCE_META_STRICT)) {
          throw new BadRequestException({
            error: 'invalid_meta',
            issues: dropped,
          });
        }
        this.logger.warn(
          `document meta has ${dropped.length} non-projectable entr(ies): ${dropped[0]}`,
        );
      }
    }
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
        if (storeContent && chunks.length > 0) {
          // One INSERT for all chunks instead of one CREATE per chunk
          // (up to ~43 serial round-trips per stored document at the
          // DOC_MAX_CHARS cap).
          await db.query(`INSERT INTO source_chunk $rows`, {
            rows: chunks.map((c) => ({
              docId: new StringRecordId(`source_document:${idTailOf(docId)}`),
              seq: c.seq,
              text: c.text,
              charStart: c.charStart,
              charEnd: c.charEnd,
            })),
          });
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

  /**
   * Re-indexable documents, id-ordered with an exclusive cursor — the
   * backfill job's pagination. Only documents with stored content
   * qualify (storeContent=false was the caller's explicit trade).
   */
  async listReindexable(
    companyId: string,
    p: { afterId?: string; limit: number },
  ): Promise<StoredDocument[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT * FROM source_document
         WHERE hasContent = true AND status != 'purged'
           ${p.afterId ? `AND id > type::record('source_document', $after)` : ''}
         ORDER BY id ASC LIMIT $limit`,
        { after: p.afterId ? idTailOf(p.afterId) : undefined, limit: p.limit },
      );
      return (((rows as any[]) ?? []) as Record<string, unknown>[]).map(mapDoc);
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
      const flagged = await markFactsProvenancePurged(db, docId);
      if (flagged > 0) {
        this.logger.log(
          `purge ${docId}: flagged ${flagged} facts provenancePurged`,
        );
      }
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

/**
 * Purging a document's text does NOT retract the facts committed from it —
 * the claims stay believed; what's gone is the reproducible evidence behind
 * them. Flag those facts (`source.provenancePurged = true`) so operators
 * and read paths can tell "grounded in retrievable text" from "source text
 * erased" instead of silently orphaning the provenance. Idempotent —
 * already-flagged facts are skipped; returns the number flagged. Shared by
 * both purge paths (explicit endpoint + retainUntil sweeper).
 */
export async function markFactsProvenancePurged(
  db: Pick<Surreal, 'query'>,
  docId: string,
): Promise<number> {
  // Facts store the FULL record id string ('source_document:<tail>', see
  // commit-writer); accept a bare tail defensively.
  const fullId = docId.includes(':') ? docId : `source_document:${docId}`;
  const [rows] = await db.query<[Array<{ n: number }>]>(
    `SELECT count() AS n FROM knowledge_fact
      WHERE source.documentId = $docId AND source.provenancePurged != true
      GROUP ALL`,
    { docId: fullId },
  );
  const n = (rows as Array<{ n: number }>)?.[0]?.n ?? 0;
  if (n > 0) {
    await db.query(
      `UPDATE knowledge_fact SET source.provenancePurged = true
        WHERE source.documentId = $docId AND source.provenancePurged != true
        RETURN NONE`,
      { docId: fullId },
    );
  }
  return n;
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
    ...(row.meta && typeof row.meta === 'object'
      ? { meta: row.meta as Record<string, unknown> }
      : {}),
  };
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
