import { Injectable } from '@nestjs/common';
import type { Connector, ConnectorConnectionView, ConnectorCtx, FetchedItem } from './connector';
import type { SourceConnectionRow } from './source-connection.service';
import { SourceGonePolicyService } from './source-gone-policy.service';
import { SourceItemIngestService, type ItemEffectOutcome } from './source-item-ingest.service';
import type { SourceItemRow } from './source-item.service';

/**
 * SourceItemEffectsService — the engine's one seam to "what happens to
 * an item": fetched → ingested (SourceItemIngestService), gone → the
 * delete policy (SourceGonePolicyService). A facade in the
 * ingest.service.ts mold, so the runner keeps three dependencies.
 */
@Injectable()
export class SourceItemEffectsService {
  constructor(
    private readonly ingest: SourceItemIngestService,
    private readonly gone: SourceGonePolicyService,
  ) {}

  fetchAndIngest(p: {
    companyId: string;
    ctx: ConnectorCtx;
    connector: Connector;
    row: SourceItemRow;
  }): Promise<ItemEffectOutcome> {
    return this.ingest.fetchAndIngest(p);
  }

  /** The ingest half alone — content an agent fetched on its host. */
  ingestFetched(p: {
    companyId: string;
    connection: ConnectorConnectionView;
    row: SourceItemRow;
    fetched: FetchedItem;
  }): Promise<ItemEffectOutcome> {
    return this.ingest.ingestFetched(p);
  }

  /** The delete policy for items the source reports gone. */
  applyGone(companyId: string, connection: SourceConnectionRow, rows: SourceItemRow[]): Promise<number> {
    return this.gone.apply(companyId, connection, rows);
  }
}

export type { ItemEffectOutcome };
