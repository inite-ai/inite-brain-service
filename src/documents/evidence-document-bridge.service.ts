import { Injectable, Logger } from '@nestjs/common';
import { evidenceDocumentBridgeEnabled } from '../common/evidence-flags';
import { SurrealService, queryFirst } from '../db/surreal.service';
import { EvidenceStoreService } from '../evidence/evidence-store.service';
import { idTailOf } from '../ingest/ingest-utils';
import { DocumentIngestService } from './document-ingest.service';
import { runWithWriteScope } from '../auth/write-scope';
import { internalDocumentMeta } from './document-meta';
import { DOC_TEXT_HARD_CAP, type IngestDocumentDto } from './dto/ingest-document.dto';

/** What one bridge job did — the job_run.result shape. */
export interface EvidenceBridgeResult {
  /** Document-sized parts the representation text was split into. */
  parts: number;
  ingested: number;
  deduplicated: number;
  failed: number;
  /** Set on a clean no-op; the counters are then all zero. */
  skipped?: string;
}

/** The evidence-side rows the bridge reads. */
interface RepresentationRow {
  kind: string;
  subjectKind: string;
  content?: string | null;
  supersededBy?: unknown;
}

interface AssetRow {
  id: unknown;
  modality: string;
  availability: string;
  vertical: string;
  recorder?: string | null;
  occurredAt: unknown;
  originUri?: string | null;
  userId?: string | null;
  /** Row-level provenance the uploader left (the source plane's header). */
  meta?: Record<string, unknown> | null;
}

/** The source-plane header keys an asset may carry, copied onto every document made of it. */
const SOURCE_HEADER_KEYS = [
  'sourceConnectionId',
  'sourceItemId',
  'sourceVersionSystem',
  'sourceVersionRef',
  'sourceVersionValue',
  'sourceVersionReadAt',
] as const;
/** The flat ABAC labels the text door writes, mirrored on bridged documents. */
const SOURCE_LABEL_KEYS = ['source_connection', 'source_pack', 'source_id'] as const;

/** The header a source-plane asset carries, or nothing for any other asset. */
function sourceHeaderOf(asset: AssetRow): {
  internal: Partial<Record<(typeof SOURCE_HEADER_KEYS)[number], string>>;
  labels: Record<string, string>;
} {
  const meta = asset.meta ?? {};
  const internal: Partial<Record<(typeof SOURCE_HEADER_KEYS)[number], string>> = {};
  for (const k of SOURCE_HEADER_KEYS) {
    const v = meta[k];
    if (typeof v === 'string' && v.length > 0) internal[k] = v;
  }
  const labels: Record<string, string> = {};
  for (const k of SOURCE_LABEL_KEYS) {
    const v = meta[k];
    if (typeof v === 'string' && v.length > 0) labels[k] = v;
  }
  return { internal, labels };
}

/**
 * The scope a source-plane asset was stored under (`sourceScope` in its
 * meta, written by the source plane's binary door). Strings only, and
 * fail-closed: a scope we cannot read is an empty one — tenant-global —
 * because the alternative is inventing a tag nobody holds, which hides
 * the row from everyone including its owner.
 */
export function assetScopeOf(asset: AssetRow): string[] {
  const raw = (asset.meta ?? {})['sourceScope'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/** `kind` on the source_document rows the bridge writes. */
export const EVIDENCE_BRIDGE_DOCUMENT_KIND = 'evidence_text';

/** The job payload / the runner's argument — one representation. */
export interface EvidenceBridgeRef {
  assetId: string;
  representationId: string;
  packId: string;
}

/** Job dedup: one bridge per (asset, representation) — a replayed
 *  dispatch or a second sweep collapses on it. Shared with the broker's
 *  enqueue (the two ends of the seam must agree on the key). */
export function evidenceBridgeDedupKey(assetId: string, representationId: string): string {
  return `evbridge_${idTailOf(assetId)}_${idTailOf(representationId)}`;
}

/**
 * Evidence → document bridge (EVIDENCE_DOCUMENT_BRIDGE) — the seam the
 * two half-pipelines were missing.
 *
 * A processor adapter turns a `document` asset (a PDF today) into an
 * asset-level `text` representation; the fragment lane cannot even see
 * an asset-level row, and nothing ever handed the text to the document
 * pipeline, so an uploaded PDF produced zero facts. This service owns
 * the `evidence_document_bridge` job: the BROKER enqueues one per
 * successful (or replayed) text run — it lives in the evidence module
 * and cannot reach this one, the queue is the seam — and the handler
 * here re-reads the representation, shapes it as an ordinary
 * `ingest/document` with an `evidenceAssetId` provenance hop, and lets
 * the normal pipeline (chunking, router, indexers, candidates, commit)
 * do what it does for every other document. No bespoke fact path.
 *
 * Idempotency is three-layered: the job dedupKey (asset, representation),
 * the store's contentHash UNIQUE (identical text is `deduplicated`),
 * and the indexer_run ledger behind it. A superseded representation is
 * skipped — the run that superseded it enqueued its own bridge.
 *
 * This is the RUNNER; the jobs plumbing (register + enqueue) is
 * EvidenceDocumentBridgeQueueService, the compaction/refit split. Every
 * skip is a named result, never a thrown error — a job that "fails"
 * because the flag was turned off mid-flight would only retry.
 */
@Injectable()
export class EvidenceDocumentBridgeService {
  private readonly logger = new Logger(EvidenceDocumentBridgeService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly ingest: DocumentIngestService,
    private readonly store: EvidenceStoreService,
  ) {}

  /**
   * Bridge one representation. Clean skips (flag off, row gone, wrong
   * shape, asset tombstoned) return a named `skipped`; per-part ingest
   * failures are counted and the remaining parts proceed.
   */
  async bridge(
    companyId: string,
    p: EvidenceBridgeRef,
    abortSignal?: AbortSignal,
  ): Promise<EvidenceBridgeResult> {
    const zero: EvidenceBridgeResult = { parts: 0, ingested: 0, deduplicated: 0, failed: 0 };
    if (!evidenceDocumentBridgeEnabled()) return { ...zero, skipped: 'flag_off' };

    const rep = await this.loadRepresentation(companyId, p.representationId);
    if (!rep) return { ...zero, skipped: 'representation_missing' };
    if (rep.kind !== 'text' || rep.subjectKind !== 'asset') {
      return { ...zero, skipped: 'not_asset_text' };
    }
    if (rep.supersededBy != null) return { ...zero, skipped: 'superseded' };
    const text = typeof rep.content === 'string' ? rep.content.trim() : '';
    if (text.length === 0) return { ...zero, skipped: 'empty_text' };

    const asset = (await this.store.getAsset(companyId, p.assetId)) as AssetRow | null;
    if (!asset) return { ...zero, skipped: 'asset_missing' };
    if (asset.modality !== 'document') return { ...zero, skipped: 'not_document_modality' };
    if (asset.availability === 'gone') return { ...zero, skipped: 'asset_gone' };

    const parts = splitForDocuments(text, DOC_TEXT_HARD_CAP);
    const result: EvidenceBridgeResult = { ...zero, parts: parts.length };
    // A source-plane asset's header rides through: the documents made of
    // it are stamped and labelled exactly like a text item's, so the
    // drift sweep and the gone policy treat both shapes the same.
    const header = sourceHeaderOf(asset);
    const internal = internalDocumentMeta({
      evidenceAssetId: String(asset.id),
      evidenceRepresentationId: p.representationId,
      ...header.internal,
    });
    for (let i = 0; i < parts.length; i++) {
      if (abortSignal?.aborted) {
        // A deploy mid-batch must not read as "done": throw so the job
        // requeues; already-ingested parts dedup on the re-run.
        throw new Error('aborted');
      }
      const dto = this.partDto({
        asset,
        packId: p.packId,
        text: parts[i] ?? '',
        index: i,
        labels: header.labels,
      });
      try {
        // W5: the asset carries the scope its item belonged to, because
        // this work runs in a JOB — long after the door's own span. The
        // documents, chunks and facts made here inherit it.
        const r = await runWithWriteScope(assetScopeOf(asset), () =>
          this.ingest.ingestDocument(companyId, dto, { channel: 'evidence', internal }),
        );
        if (r.deduplicated) result.deduplicated++;
        else result.ingested++;
      } catch (err) {
        result.failed++;
        this.logger.warn(
          `evidence bridge part ${i + 1}/${parts.length} of ${p.assetId} failed for ${companyId}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `evidence bridge ${p.assetId} for ${companyId}: parts=${result.parts} ingested=${result.ingested} deduplicated=${result.deduplicated} failed=${result.failed}`,
    );
    return result;
  }

  private async loadRepresentation(
    companyId: string,
    representationId: string,
  ): Promise<RepresentationRow | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const row = await queryFirst<RepresentationRow>(
        db,
        `SELECT kind, subjectKind, content, supersededBy FROM type::record('derived_representation', $tail) LIMIT 1`,
        { tail: idTailOf(representationId) },
      );
      return row ?? null;
    });
  }

  /** Shape one part as a normal document-pipeline ingest. */
  private partDto(p: {
    asset: AssetRow;
    packId: string;
    text: string;
    index: number;
    labels: Record<string, string>;
  }): IngestDocumentDto {
    const assetId = String(p.asset.id);
    const base = p.asset.originUri ?? `evidence://asset/${idTailOf(assetId)}`;
    return {
      kind: EVIDENCE_BRIDGE_DOCUMENT_KIND,
      text: p.text,
      // Part suffix keeps a split document's provenance distinct without
      // pretending the parts are separate sources.
      originUri: p.index === 0 ? base : `${base}#part=${p.index + 1}`,
      occurredAt: toIso(p.asset.occurredAt),
      ...(typeof p.asset.userId === 'string' && p.asset.userId.length > 0
        ? { userId: p.asset.userId }
        : {}),
      // The asset's own vertical/recorder: the facts stay attributed to
      // whoever brought the bytes, not to the bridge.
      contextRef: {
        vertical: p.asset.vertical,
        ...(typeof p.asset.recorder === 'string' && p.asset.recorder.length > 0
          ? { recorder: p.asset.recorder }
          : {}),
      },
      // Flat scalar, snake_case — survives sanitizeSourceMeta verbatim, so
      // an ABAC rule can match `source.meta.evidence_bridge`.
      meta: { evidence_bridge: true, ...p.labels },
      // Stored content keeps the document re-indexable and span-groundable.
      storeContent: true,
      mode: 'sync',
      // The pack whose processor produced the text reads it first; with
      // DOCUMENT_MULTI_INDEXER_ENABLED off this is the union pass.
      indexers: [p.packId],
    };
  }
}

/**
 * Split extracted text into document-sized parts at paragraph
 * boundaries. A representation may be up to EVIDENCE_DERIVED_MAX_BYTES
 * (1 MiB default) while a document is capped at DOC_TEXT_HARD_CAP chars;
 * "connectors with more split into multiple documents" — this is that
 * split. A single paragraph longer than the cap is cut hard.
 */
export function splitForDocuments(text: string, cap: number): string[] {
  if (text.length <= cap) return [text];
  const out: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const piece = paragraph.length > cap ? hardCut(paragraph, cap) : [paragraph];
    for (const chunk of piece) {
      if (current.length === 0) {
        current = chunk;
      } else if (current.length + 2 + chunk.length <= cap) {
        current = `${current}\n\n${chunk}`;
      } else {
        out.push(current);
        current = chunk;
      }
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

function hardCut(s: string, cap: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += cap) out.push(s.slice(i, i + cap));
  return out;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
