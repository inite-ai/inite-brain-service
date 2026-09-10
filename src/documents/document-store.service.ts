import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { StringRecordId, Surreal } from 'surrealdb';
import {
  SurrealService,
  dbCreate,
  isUniqueViolation,
  queryFirst,
  queryRows,
} from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';
import { sanitizeIngestText } from '../common/text-sanitizer';
import { sanitizeSourceMeta } from '../policy/source-meta';
import { idTailOf, redactPii } from '../ingest/ingest-utils';
import { MetricsService } from '../metrics/metrics.service';
import { scopeForUser } from '../auth/scope-tags';
import { chunkDocument, DocumentChunk } from './chunker';
import {
  mergeDocumentMeta,
  reservedKeysIn,
  type DocumentWriteOrigin,
  type InternalDocumentMeta,
} from './document-meta';
import { markFactsProvenancePurged, purgeDocumentChunks } from './document-purge.util';
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
  recorder?: string | undefined;
  occurredAt: Date;
  status: string;
  /**
   * Per-user memory scope (0128). Set = the document (and everything the
   * pipeline derives from it — committed facts, projected scenes) belongs
   * to one end-user's slice of the tenant; absent = tenant-global. Rides
   * the stored row so async fan-out, re-commits and the sweeper all see
   * the same scope the ingest request asserted.
   */
  userId?: string | undefined;
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
   *
   * `origin` names the writer and carries brain's OWN document-header
   * keys (see document-meta.ts) — bounded upstream by
   * `internalDocumentMeta`, so they bypass the caller gate below by
   * construction: the gate polices untrusted operator vocabulary destined
   * for the ABAC `source.meta` surface, and an internal writer is neither.
   * `origin.internal` is required (undefined allowed) so a new writer
   * cannot drop a provenance hop by leaving an argument off.
   */
  async createOrGet(
    companyId: string,
    dto: IngestDocumentDto,
    origin: DocumentWriteOrigin,
  ): Promise<CreateDocumentResult> {
    // CALLER meta becomes ABAC-matchable `source.meta` on every derived
    // fact (commit-writer projection), so it must be operator
    // vocabulary. Default: sanitize-and-warn; SOURCE_META_STRICT=1
    // rejects instead — a silently-dropped data_class would silently
    // widen access. Only dto.meta is checked: brain's own provenance is
    // not caller input and is merged in AFTER this gate.
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
    // Brain's keys are brain's: a caller asserting one has it dropped,
    // loudly. `toolObservationRef` rides into every derived fact's
    // source.evidence[] verbatim, so an accepted caller copy would be a
    // provenance hop nobody earned.
    const reserved = reservedKeysIn(dto.meta);
    if (reserved.length > 0) {
      this.logger.warn(`document meta asserts ${reserved.length} reserved key(s): ${reserved[0]}`);
    }
    const meta = mergeDocumentMeta(dto.meta, origin.internal);
    // G9 ingest sanitization (INGEST_SANITIZE_UNICODE, default off):
    // strip bidi/zero-width/control chars from the document body BEFORE
    // redaction, hashing, and chunking — so stored chunks (and the spans
    // external indexers later re-ground against them) see de-obfuscated
    // text. Layout is preserved, so chunk boundaries are unaffected. Flag
    // off → dto.text flows through verbatim (byte-identical, hash stable).
    const rawText = envFlagEnabled(process.env.INGEST_SANITIZE_UNICODE)
      ? sanitizeIngestText(dto.text)
      : dto.text;
    const text = redactPii(rawText).trim();
    // 0128: the dedupe/origin hash is scope-local. A tenant-global
    // document hashes the text exactly as before (byte-identical); a
    // user-scoped one salts the preimage with its user, so the UNIQUE
    // contentHash index can never dedupe a user's document onto a
    // tenant-global row or another user's (which would have committed
    // this caller's memory under THAT row's scope). Same-user re-posts
    // still dedupe; two users asserting the same text stay independent
    // origins for corroboration (0050) — scope-local facts anyway.
    const contentHash =
      dto.userId === undefined ? sha256Hex(text) : userScopedContentHash(dto.userId, text);
    // G9 write-anomaly signal (one increment per document body stored).
    this.metrics?.countIngestWrite('document');
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
          meta,
          status: 'received',
          // Per-user scope (0128): userId + the 0093 scope-tag mirror.
          // Tenant-global writes keep the field absent / scope [] — the
          // column DEFAULT — so pre-0128 rows and new global rows match.
          userId: dto.userId,
          scope: scopeForUser(dto.userId),
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
        // Scope fence on the dedupe hit (0128): the salted preimages make
        // a cross-scope hash equality unreachable for honest input, but a
        // writer could still CRAFT a text that byte-equals another scope's
        // preimage. Refusing beats adopting the other scope's row — which
        // would leak its document id and commit this request's extraction
        // under the WRONG scope.
        if ((existing.userId ?? undefined) !== (dto.userId ?? undefined)) {
          throw new ConflictException(
            'document content collides with an existing document in a different user scope',
          );
        }
        this.logger.log(
          `document dedupe hit contentHash=${contentHash.slice(0, 12)}… doc=${existing.id}`,
        );
        this.metrics?.countDocument('deduplicated');
        const doc = await this.adoptInternalMeta(db, existing, origin.internal);
        return { doc, chunks, deduplicated: true };
      }
    });
  }

  /**
   * A dedupe hit returns the row that already exists, so the brain-owned
   * provenance THIS request carried has nowhere to land. The 0111
   * tool-observation hop is merged onto the stored header when that
   * header has none: the bytes are byte-identical and in the same user
   * scope (fenced above), the ref was verified for this tenant, and the
   * commit writer reads the hop off the header — so without the merge a
   * re-post's verified observation is dropped from every fact committed
   * afterwards, with only a generic dedupe line in the log.
   *
   * Never overwritten: a header that already carries a hop keeps it (one
   * true observation must not displace another), and the origin
   * identifiers (conversationId / messageId / eventId) name the turn the
   * header was first stored for. Those keys are reported at warn with the
   * document id instead of being written or swallowed.
   */
  private async adoptInternalMeta(
    db: Surreal,
    existing: StoredDocument,
    internal: InternalDocumentMeta | undefined,
  ): Promise<StoredDocument> {
    if (internal === undefined) return existing;
    const stored: Record<string, unknown> = existing.meta ?? {};
    const adoptHop =
      typeof internal.toolObservationRef === 'string' &&
      typeof stored['toolObservationRef'] !== 'string';
    const patch: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(internal)) {
      if (typeof value !== 'string') continue;
      const isHop = key === 'toolObservationRef' || key === 'toolObservationNote';
      if (isHop && adoptHop) patch[key] = value;
      else if (stored[key] !== value) dropped.push(key);
    }
    if (dropped.length > 0) {
      this.logger.warn(
        `document dedupe hit doc=${existing.id} dropped internal meta: ${dropped.join(', ')}`,
      );
    }
    if (Object.keys(patch).length === 0) return existing;
    const meta = { ...stored, ...patch };
    await db.query(`UPDATE type::record('source_document', $id) SET meta = $meta`, {
      id: idTailOf(existing.id),
      meta,
    });
    this.logger.log(`document dedupe hit doc=${existing.id} adopted the tool-observation hop`);
    return { ...existing, meta };
  }

  async getById(companyId: string, docId: string): Promise<StoredDocument | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const row = await queryFirst<Record<string, unknown>>(
        db,
        `SELECT * FROM type::record('source_document', $id)`,
        { id: idTailOf(docId) },
      );
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
    p: { afterId?: string | undefined; limit: number },
  ): Promise<StoredDocument[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<Record<string, unknown>>(
        db,
        `SELECT * FROM source_document
         WHERE hasContent = true AND status != 'purged'
           ${p.afterId ? `AND id > type::record('source_document', $after)` : ''}
         ORDER BY id ASC LIMIT $limit`,
        { after: p.afterId ? idTailOf(p.afterId) : undefined, limit: p.limit },
      );
      return rows.map(mapDoc);
    });
  }

  /** Stored chunks (empty for hasContent=false documents). */
  async getChunks(companyId: string, docId: string): Promise<DocumentChunk[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const rows = await queryRows<DocumentChunk>(
        db,
        `SELECT seq, text, charStart, charEnd FROM source_chunk
         WHERE docId = type::record('source_document', $id) ORDER BY seq ASC`,
        { id: idTailOf(docId) },
      );
      return rows.map((r) => ({
        seq: r.seq,
        text: r.text,
        charStart: r.charStart,
        charEnd: r.charEnd,
      }));
    });
  }

  async setStatus(p: { companyId: string; docId: string; status: string }): Promise<void> {
    await this.surreal.withCompany(p.companyId, async (db) => {
      await db.query(`UPDATE type::record('source_document', $id) SET status = $status`, {
        id: idTailOf(p.docId),
        status: p.status,
      });
    });
  }

  /**
   * Explicit erasure: delete the chunk rows, keep the header + contentHash
   * (re-ingest of the same text still dedupes; committed facts keep a
   * resolvable documentId pointer).
   */
  async purgeContent(companyId: string, docId: string): Promise<boolean> {
    return this.surreal.withCompany(companyId, async (db) => {
      const existing = await queryFirst<{ id: unknown }>(
        db,
        `SELECT id FROM type::record('source_document', $id)`,
        { id: idTailOf(docId) },
      );
      if (!existing) return false;
      // Batched two-step chunk purge — shared idiom, see document-purge.util.
      await purgeDocumentChunks(db, docId);
      await db.query(
        `UPDATE type::record('source_document', $id)
           SET status = 'purged', hasContent = false`,
        { id: idTailOf(docId) },
      );
      const flagged = await markFactsProvenancePurged(db, docId);
      if (flagged > 0) {
        this.logger.log(`purge ${docId}: flagged ${flagged} facts provenancePurged`);
      }
      return true;
    });
  }

  private async byContentHash(db: Surreal, contentHash: string): Promise<StoredDocument | null> {
    const row = await queryFirst<Record<string, unknown>>(
      db,
      `SELECT * FROM source_document WHERE contentHash = $h LIMIT 1`,
      { h: contentHash },
    );
    return row ? mapDoc(row) : null;
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Scope-salted content hash for a USER-SCOPED document (0128): the
 * user's id frames the text, so identical text under different scopes
 * yields different contentHash values — the UNIQUE dedupe index and the
 * 'doc:'-prefixed originKey (0050) both become scope-local. NUL framing
 * keeps honest inputs collision-free across scopes; the residual crafted
 * -preimage case is refused at the dedupe seam (see createOrGet).
 * Tenant-global documents keep the plain sha256Hex(text) — byte-identical
 * hashes, dedupe and corroboration keys.
 */
export function userScopedContentHash(userId: string, text: string): string {
  return sha256Hex(`\u0000user-scope\u0000${userId}\u0000${text}`);
}

/** 'doc:' + contentHash — the origin identity migration 0050 keys on. */
export function originKeyOf(contentHash: string): string {
  return `doc:${contentHash}`;
}

// Re-exported from its extracted home (document-purge.util) so existing
// importers keep working; the GDPR forget cascade shares the same helper.
export { markFactsProvenancePurged } from './document-purge.util';

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
    ...(row.userId ? { userId: String(row.userId) } : {}),
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
