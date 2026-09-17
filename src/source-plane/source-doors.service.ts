import { Injectable } from '@nestjs/common';
import type { SourceVersionStamp } from '../common/source-version';
import { DocumentIngestService } from '../documents/document-ingest.service';
import { internalDocumentMeta } from '../documents/document-meta';
import { DOC_TEXT_HARD_CAP, type IngestDocumentDto } from '../documents/dto/ingest-document.dto';
import { EvidenceUploadService } from '../evidence/evidence-upload.service';
import { idTailOf } from '../ingest/ingest-utils';
import { IngestService } from '../ingest/ingest.service';
import type { IngestMentionDto } from '../ingest/dto/ingest-mention.dto';
import type {
  ConnectorConnectionView,
  FetchedItem,
  ItemDescriptor,
  RecordEnvelope,
} from './connector';

/** What a door wrote — the catalogue links to it. */
export interface DoorOutcome {
  documentId?: string | undefined;
  assetId?: string | undefined;
  episodeId?: string | undefined;
  contentHash?: string | undefined;
  byteHash?: string | undefined;
  /** The store already had identical content. */
  deduplicated: boolean;
}

/** `kind` on rows the doors write when the connector names none. */
export const SOURCE_DOCUMENT_KIND = 'source_document';
export const SOURCE_RECORD_KIND = 'source_record';

/**
 * SourceDoorsService — "shape decides the door" (raw-evidence-sources
 * doctrine 2). A connector fetches an item in the shape the pack
 * declared, and this service hands it to the EXISTING ingest path for
 * that shape; there is no fifth path:
 *
 *   document     → DocumentIngestService (chunking, router, indexers,
 *                  candidates, commit — the same call pack seeds make)
 *   binary       → EvidenceUploadService (content-addressed blob,
 *                  quarantine scan, processor dispatch; the evidence →
 *                  document bridge carries text onward)
 *   conversation → IngestService.ingestMention per turn (episode
 *                  substrate, the dialogue machinery)
 *   structure    → the record envelope rendered deterministically and
 *                  ingested as a document (kind 'source_record'); the
 *                  attribute → predicate candidate path is W4's
 *
 * Provenance every door writes: the connection's vertical + recorder as
 * contextRef, the item's originUri, the source's own clock as
 * occurredAt, the owner's userId, and — on the document doors — the
 * source-plane header keys (connection, item, revision stamp) that the
 * commit writer folds into `source.sourceVersion`.
 */
@Injectable()
export class SourceDoorsService {
  constructor(
    private readonly documents: DocumentIngestService,
    private readonly evidence: EvidenceUploadService,
    private readonly mentions: IngestService,
  ) {}

  async ingest(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    fetched: FetchedItem;
    stamp: SourceVersionStamp | null;
  }): Promise<DoorOutcome> {
    switch (p.fetched.shape) {
      case 'document':
        return this.documentDoor({ ...p, fetched: p.fetched });
      case 'binary':
        return this.binaryDoor({ ...p, fetched: p.fetched });
      case 'conversation':
        return this.conversationDoor({ ...p, fetched: p.fetched });
      case 'structure':
        return this.structureDoor({ ...p, fetched: p.fetched });
    }
  }

  private async documentDoor(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    fetched: Extract<FetchedItem, { shape: 'document' }>;
    stamp: SourceVersionStamp | null;
  }): Promise<DoorOutcome> {
    const text = p.fetched.text.slice(0, DOC_TEXT_HARD_CAP);
    return this.ingestDocumentText({
      ...p,
      text,
      kind: p.fetched.kind ?? SOURCE_DOCUMENT_KIND,
      title: p.fetched.title ?? p.item.title,
      occurredAt: p.fetched.occurredAt ?? p.item.modifiedAt,
      meta: {},
    });
  }

  private async structureDoor(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    fetched: Extract<FetchedItem, { shape: 'structure' }>;
    stamp: SourceVersionStamp | null;
  }): Promise<DoorOutcome> {
    const record = p.fetched.record;
    return this.ingestDocumentText({
      ...p,
      text: renderRecord(record),
      kind: SOURCE_RECORD_KIND,
      title: record.name,
      occurredAt: record.updatedAt ?? p.item.modifiedAt,
      meta: { record_type: record.entityType.slice(0, 256) },
    });
  }

  private async ingestDocumentText(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    stamp: SourceVersionStamp | null;
    text: string;
    kind: string;
    title: string | undefined;
    occurredAt: string | undefined;
    meta: Record<string, string | number | boolean>;
  }): Promise<DoorOutcome> {
    const dto: IngestDocumentDto = {
      kind: p.kind.slice(0, 64),
      text: p.text,
      originUri: originUriOf(p.connection, p.item),
      ...(p.title ? { title: p.title.slice(0, 512) } : {}),
      occurredAt: toIso(p.occurredAt),
      ...(p.connection.userId ? { userId: p.connection.userId } : {}),
      contextRef: { vertical: p.connection.vertical, recorder: p.connection.recorder },
      // Flat snake_case scalars — survive sanitizeSourceMeta verbatim, so
      // ABAC can match `source.meta.source_connection`.
      meta: {
        source_connection: idTailOf(p.connection.id),
        source_pack: p.connection.packId,
        source_id: p.connection.sourceId,
        ...p.meta,
      },
      storeContent: true,
      mode: 'sync',
      indexers: [p.connection.packId],
    };
    const internal = internalDocumentMeta({
      sourceConnectionId: p.connection.id,
      sourceItemId: p.itemId,
      ...(p.stamp
        ? {
            sourceVersionSystem: p.stamp.system,
            sourceVersionRef: p.stamp.ref,
            sourceVersionValue: p.stamp.version,
            sourceVersionReadAt: p.stamp.readAt,
          }
        : {}),
    });
    const r = await this.documents.ingestDocument(p.companyId, dto, {
      channel: 'source',
      internal,
    });
    return { documentId: r.documentId, deduplicated: r.deduplicated === true };
  }

  private async binaryDoor(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    fetched: Extract<FetchedItem, { shape: 'binary' }>;
    stamp: SourceVersionStamp | null;
  }): Promise<DoorOutcome> {
    const r = await this.evidence.upload(
      p.companyId,
      {
        originalname: p.item.title ?? p.item.path ?? p.item.externalId,
        mimetype: p.fetched.mediaType,
        size: p.fetched.bytes.byteLength,
        buffer: p.fetched.bytes,
      },
      {
        modality: p.fetched.modality,
        mediaType: p.fetched.mediaType,
        occurredAt: new Date(toIso(p.fetched.occurredAt ?? p.item.modifiedAt)),
        vertical: p.connection.vertical,
        ...(p.connection.userId ? { userId: p.connection.userId } : {}),
        recorder: p.connection.recorder,
        // The pack whose source this is gets the processor dispatch — its
        // media contract decides what runs; the bridge carries text on.
        packId: p.connection.packId,
        // The same header a text item's document gets, on the asset: the
        // bridge folds it into every document it makes of the asset, so
        // the facts are stamped for the drift sweep and the gone policy
        // can find them (source-plane.md § binary).
        meta: sourceAssetMeta(p),
      },
    );
    return { assetId: r.assetId, byteHash: r.byteHash, deduplicated: r.deduped };
  }

  private async conversationDoor(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    item: ItemDescriptor;
    fetched: Extract<FetchedItem, { shape: 'conversation' }>;
  }): Promise<DoorOutcome> {
    let episodeId: string | undefined;
    for (const [i, turn] of p.fetched.turns.entries()) {
      const text = turn.speaker ? `${turn.speaker}: ${turn.text}` : turn.text;
      const dto: IngestMentionDto = {
        text: text.slice(0, 16_000),
        contextRef: {
          vertical: p.connection.vertical,
          conversationId: p.fetched.conversationId,
          messageId: turn.messageId ?? `${p.item.externalId}#${i}`,
          recorder: p.connection.recorder,
        },
        ...(p.connection.userId ? { userId: p.connection.userId } : {}),
        emittedAt: toIso(turn.at ?? p.item.modifiedAt),
      };
      const r = (await this.mentions.ingestMention(p.companyId, dto)) as { episodeId?: unknown };
      if (typeof r?.episodeId === 'string') episodeId = r.episodeId;
    }
    return { ...(episodeId ? { episodeId } : {}), deduplicated: false };
  }
}

/** `originUri` fallback: a stable, brain-owned pointer per catalogue row. */
export function originUriOf(connection: ConnectorConnectionView, item: ItemDescriptor): string {
  const uri =
    item.originUri ?? `source://${idTailOf(connection.id)}/${encodeURIComponent(item.externalId)}`;
  return uri.slice(0, 512);
}

/**
 * Deterministic rendering of a record envelope — the same envelope
 * always yields the same text, so the document contentHash dedupes an
 * unchanged record and a changed attribute is a new document.
 */
export function renderRecord(r: RecordEnvelope): string {
  const lines = [`${r.entityType}: ${r.name}`, `id: ${r.externalId}`];
  for (const key of Object.keys(r.attributes).sort()) {
    const v = r.attributes[key];
    if (v === null || v === undefined) continue;
    lines.push(`${key}: ${String(v)}`);
  }
  for (const rel of r.relations ?? []) {
    lines.push(`${rel.kind}: ${rel.targetType} ${rel.targetName ?? rel.targetExternalId}`);
  }
  if (r.updatedAt) lines.push(`updated_at: ${r.updatedAt}`);
  return lines.join('\n');
}

function toIso(v: string | undefined): string {
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * The provenance header an asset carries for the bridge: the internal
 * document-meta keys verbatim (the bridge copies them through
 * internalDocumentMeta) plus the flat ABAC labels the text door writes.
 */
export function sourceAssetMeta(p: {
  connection: ConnectorConnectionView;
  itemId: string;
  stamp: SourceVersionStamp | null;
}): Record<string, unknown> {
  return {
    sourceConnectionId: p.connection.id,
    sourceItemId: p.itemId,
    source_connection: idTailOf(p.connection.id),
    source_pack: p.connection.packId,
    source_id: p.connection.sourceId,
    ...(p.stamp
      ? {
          sourceVersionSystem: p.stamp.system,
          sourceVersionRef: p.stamp.ref,
          sourceVersionValue: p.stamp.version,
          sourceVersionReadAt: p.stamp.readAt,
        }
      : {}),
  };
}
