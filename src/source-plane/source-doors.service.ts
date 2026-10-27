import { Injectable } from '@nestjs/common';
import { scopeForSource } from '../auth/scope-tags';
import { runWithWriteScope } from '../auth/write-scope';
import type { SourceVersionStamp } from '../common/source-version';
import { DocumentIngestService } from '../documents/document-ingest.service';
import { internalDocumentMeta } from '../documents/document-meta';
import { DOC_TEXT_HARD_CAP, type IngestDocumentDto } from '../documents/dto/ingest-document.dto';
import { EvidenceUploadService } from '../evidence/evidence-upload.service';
import { idTailOf } from '../ingest/ingest-utils';
import { IngestService } from '../ingest/ingest.service';
import type { IngestMentionDto } from '../ingest/dto/ingest-mention.dto';
import type { ConnectorConnectionView, FetchedItem, ItemDescriptor } from './connector';
import { RecordsDoorService } from './records/records-door.service';
export { renderRecord } from './records/record-mapping';
export { SOURCE_RECORD_KIND } from './records/records-door.service';

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
 *   structure    → RecordsDoorService: the envelope rendered as the
 *                  grounding document (general extraction OFF) and its
 *                  mapped attributes submitted as deterministic
 *                  candidates — facts, not prose (W4.2)
 *
 * Provenance every door writes: the connection's vertical + recorder as
 * contextRef, the item's originUri, the source's own clock as
 * occurredAt, the owner's userId, and — on the document doors — the
 * source-plane header keys (connection, item, revision stamp) that the
 * commit writer folds into `source.sourceVersion`.
 */
@Injectable()
export class SourceDoorsService {
  // eslint-disable-next-line max-params
  constructor(
    private readonly documents: DocumentIngestService,
    private readonly evidence: EvidenceUploadService,
    private readonly mentions: IngestService,
    private readonly records: RecordsDoorService,
  ) {}

  async ingest(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    itemId: string;
    item: ItemDescriptor;
    fetched: FetchedItem;
    stamp: SourceVersionStamp | null;
  }): Promise<DoorOutcome> {
    // W5: who may see what this item produces. A personal connection is
    // user-fenced by construction and needs nothing; an org connection
    // whose item names its groups declares them here, and every
    // tenant-global write below — document, chunks, episode, entities,
    // facts — takes the scope from the ambient span rather than from a
    // `scope` argument threaded through five signatures.
    return runWithWriteScope(scopeOfItem(p.connection, p.item), () => this.door(p));
  }

  private async door(p: {
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
    const r = await this.records.ingest({
      companyId: p.companyId,
      connection: p.connection,
      itemId: p.itemId,
      item: p.item,
      record: p.fetched.record,
      mapping: p.fetched.mapping,
      stamp: p.stamp,
    });
    return { documentId: r.documentId, deduplicated: r.deduplicated };
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
        meta: sourceAssetMeta({ ...p, item: p.item }),
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

/**
 * The scope the rows of one item belong to: the owner's tag for a
 * personal connection, the groups the item names for an org one, and
 * the empty array — tenant-global — for an item that names none, which
 * is what a public repository or an open channel IS.
 */
export function scopeOfItem(connection: ConnectorConnectionView, item: ItemDescriptor): string[] {
  if (connection.userId) return [];
  return scopeForSource({
    connectionId: connection.id,
    groups: item.acl?.groups ?? [],
  });
}

/** `originUri` fallback: a stable, brain-owned pointer per catalogue row. */
export function originUriOf(connection: ConnectorConnectionView, item: ItemDescriptor): string {
  const uri =
    item.originUri ?? `source://${idTailOf(connection.id)}/${encodeURIComponent(item.externalId)}`;
  return uri.slice(0, 512);
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
  item?: ItemDescriptor | undefined;
  stamp: SourceVersionStamp | null;
}): Record<string, unknown> {
  // The binary door's work continues in a JOB — the broker, the
  // processors, the G3 bridge — long after this stack is gone, so the
  // scope cannot ride the ambient span: it rides the asset.
  const scope = p.item ? scopeOfItem(p.connection, p.item) : [];
  return {
    sourceConnectionId: p.connection.id,
    sourceItemId: p.itemId,
    ...(scope.length > 0 ? { sourceScope: scope } : {}),
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
