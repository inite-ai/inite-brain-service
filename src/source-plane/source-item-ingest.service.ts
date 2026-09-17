import { Injectable, Logger, Optional } from '@nestjs/common';
import type { SourceVersionStamp } from '../common/source-version';
import { SourceDriftStalenessService } from '../documents/source-drift-staleness.service';
import type {
  Connector,
  ConnectorConnectionView,
  ConnectorCtx,
  FetchedItem,
  ItemDescriptor,
} from './connector';
import { SourceDoorsService } from './source-doors.service';
import { SourceItemService, type SourceItemRow } from './source-item.service';

export interface ItemEffectOutcome {
  status: 'ingested' | 'deduplicated' | 'failed';
  error?: string | undefined;
}

/**
 * SourceItemIngestService — one item, end to end: fetch it through its
 * connector, hand it to the door for its shape, pin the catalogue row to
 * the revision it was read at, and let the drift sweep compare that
 * revision against facts read at older ones. One poison item is counted
 * and never sinks the run.
 */
@Injectable()
export class SourceItemIngestService {
  private readonly logger = new Logger(SourceItemIngestService.name);

  constructor(
    private readonly doors: SourceDoorsService,
    private readonly catalogue: SourceItemService,
    @Optional() private readonly drift?: SourceDriftStalenessService,
  ) {}

  async fetchAndIngest(p: {
    companyId: string;
    ctx: ConnectorCtx;
    connector: Connector;
    row: SourceItemRow;
  }): Promise<ItemEffectOutcome> {
    const { companyId, ctx, connector, row } = p;
    let fetched: FetchedItem;
    try {
      fetched = await connector.fetch(ctx, descriptorOf(row));
    } catch (err) {
      return this.failed({ companyId, connectionId: ctx.connection.id, row }, err);
    }
    return this.ingestFetched({ companyId, connection: ctx.connection, row, fetched });
  }

  /**
   * The ingest half on its own — what an AGENT-host run calls with the
   * content the agent fetched on its side of the wire: the same door,
   * the same catalogue pin, the same drift sweep.
   */
  async ingestFetched(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    row: SourceItemRow;
    fetched: FetchedItem;
  }): Promise<ItemEffectOutcome> {
    const { companyId, connection, row, fetched } = p;
    const item = descriptorOf(row);
    const stamp = stampOf(connection, row);
    try {
      const out = await this.doors.ingest({
        companyId,
        connection,
        itemId: String(row.id),
        item,
        fetched,
        stamp,
      });
      await this.catalogue.markIndexed(companyId, {
        itemId: String(row.id),
        revision: row.revision ?? null,
        documentId: out.documentId,
        assetId: out.assetId,
        episodeId: out.episodeId,
        contentHash: out.contentHash,
        byteHash: out.byteHash,
      });
      if (stamp) {
        // Marks facts read at an OLDER revision of this item stale —
        // pack-gated (only predicates the pack declares derivable),
        // flag-gated, and never fatal to the sync.
        await this.drift?.sweep({ companyId, packId: connection.packId, current: stamp });
      }
      return { status: out.deduplicated ? 'deduplicated' : 'ingested' };
    } catch (err) {
      return this.failed({ companyId, connectionId: connection.id, row }, err);
    }
  }

  private async failed(
    p: { companyId: string; connectionId: string; row: SourceItemRow },
    err: unknown,
  ): Promise<ItemEffectOutcome> {
    const message = (err as Error).message ?? String(err);
    this.logger.warn(
      `source item ${p.row.externalId} of ${p.connectionId} failed for ${p.companyId}: ${message}`,
    );
    await this.catalogue.markFailed(p.companyId, String(p.row.id), message).catch(() => undefined);
    return { status: 'failed', error: message };
  }
}

function descriptorOf(row: SourceItemRow): ItemDescriptor {
  return {
    externalId: row.externalId,
    originUri: row.originUri ?? undefined,
    path: row.path ?? undefined,
    title: row.title ?? undefined,
    mediaType: row.mediaType ?? undefined,
    size: row.size ?? undefined,
    revision: row.revision ?? undefined,
    modifiedAt: isoOrUndefined(row.modifiedAt),
    acl: row.acl ?? undefined,
  };
}

function isoOrUndefined(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * The SourceVersionStamp for one item: system = the connector kind,
 * ref = the item's location, version = the source's revision token.
 * No revision ⇒ no stamp — a fact that LOOKS bound to a version but is
 * not can never be swept (source-version.ts).
 */
export function stampOf(
  connection: ConnectorConnectionView,
  row: SourceItemRow,
): SourceVersionStamp | null {
  if (!row.revision) return null;
  return {
    system: connection.connector.slice(0, 32),
    ref: row.externalId.slice(0, 200),
    version: row.revision.slice(0, 200),
    readAt: new Date().toISOString(),
  };
}
