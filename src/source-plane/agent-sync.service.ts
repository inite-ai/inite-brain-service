import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AgentDeltasResponse,
  FetchedItemWire,
  FinishAgentRunRequest,
  ItemDeltaWire,
  SourceSyncSummary,
} from '../contracts/source-plane/source-plane.schema';
import type { ConnectorConnectionView, FetchedItem } from './connector';
import { SourceConnectionService, type SourceConnectionRow } from './source-connection.service';
import { SourceItemEffectsService } from './source-item-effects.service';
import { SourceItemService } from './source-item.service';

/** The counters an agent run accumulates across its calls (job_run.progress). */
export interface AgentRunCounters {
  seen: number;
  new: number;
  changed: number;
  unchanged: number;
  gone: number;
  fetched: number;
  ingested: number;
  deduplicated: number;
  failed: number;
}

export const ZERO_COUNTERS: AgentRunCounters = {
  seen: 0,
  new: 0,
  changed: 0,
  unchanged: 0,
  gone: 0,
  fetched: 0,
  ingested: 0,
  deduplicated: 0,
  failed: 0,
};

/** What one run remembers between calls. */
export interface AgentRunState {
  connectionId: string;
  agentId: string;
  full: boolean;
  startedAt: Date;
  checkpoint: Record<string, unknown> | null;
  counters: AgentRunCounters;
}

/**
 * AgentSyncService — the engine's bookkeeping for a run whose WALK and
 * FETCH happen on the local agent (the connector's other host). The
 * primitives are the server run's own — the catalogue's upsertSeen /
 * markGone / markUnseenGone, the doors through SourceItemIngestService,
 * the delete policy — applied to what arrives over the wire instead of
 * to a connector called in-process, so a `.md` an agent read on a
 * laptop lands exactly as one the server read from a mounted volume:
 * same recorder, same stamp, same close on delete.
 *
 * Nothing here trusts the agent beyond its key: an item is data through
 * the ordinary door, capped at the door; a revision is the agent's claim
 * and the store's content hash is the truth.
 */
@Injectable()
export class AgentSyncService {
  constructor(
    private readonly connections: SourceConnectionService,
    private readonly catalogue: SourceItemService,
    private readonly effects: SourceItemEffectsService,
  ) {}

  /** Apply one batch of deltas; answer with what the agent must fetch. */
  async applyDeltas(
    companyId: string,
    p: { row: SourceConnectionRow; run: AgentRunState; deltas: ItemDeltaWire[] },
  ): Promise<AgentDeltasResponse> {
    const { row, run, deltas } = p;
    const out: AgentDeltasResponse = { fetch: [], seen: 0, new: 0, changed: 0, unchanged: 0, gone: 0 };
    for (const delta of deltas) {
      if (delta.type === 'checkpoint') {
        run.checkpoint = delta.checkpoint;
        continue;
      }
      if (delta.type === 'gone') {
        const closed = await this.catalogue.markGoneByExternalId(companyId, {
          connectionId: run.connectionId,
          externalId: delta.externalId,
          at: new Date(),
        });
        if (closed) out.gone++;
        continue;
      }
      out.seen++;
      const seen = await this.catalogue.upsertSeen(companyId, {
        connectionId: run.connectionId,
        // A personal connection's rows are user-fenced by construction.
        userId: row.userId ?? null,
        item: delta.item,
        seenAt: run.startedAt,
      });
      if (seen.isNew) out.new++;
      else if (seen.changed) out.changed++;
      else out.unchanged++;
      if (seen.changed) out.fetch.push(delta.item.externalId);
    }
    run.counters.seen += out.seen;
    run.counters.new += out.new;
    run.counters.changed += out.changed;
    run.counters.unchanged += out.unchanged;
    run.counters.gone += out.gone;
    return out;
  }

  /** Ingest content the agent fetched for one catalogued item. */
  async ingestItem(
    companyId: string,
    p: { row: SourceConnectionRow; run: AgentRunState; externalId: string; item: FetchedItemWire },
  ): Promise<{ status: 'ingested' | 'deduplicated' | 'failed' | 'skipped'; error?: string | undefined }> {
    if (p.row.contentPolicy === 'manifest') return { status: 'skipped', error: 'contentPolicy is manifest' };
    const budget = p.row.fetchBudget ?? Number.POSITIVE_INFINITY;
    if (p.run.counters.fetched >= budget) return { status: 'skipped', error: 'fetchBudget reached' };
    const item = await this.catalogue.getByExternalId(companyId, {
      connectionId: p.run.connectionId,
      externalId: p.externalId,
    });
    if (!item) throw new NotFoundException(`item "${p.externalId}" is not catalogued in this connection`);
    const connection = await this.viewOf(companyId, p.row);
    p.run.counters.fetched++;
    const out = await this.effects.ingestFetched({
      companyId,
      connection,
      row: item,
      fetched: fromWire(p.item),
    });
    if (out.status === 'ingested') p.run.counters.ingested++;
    else if (out.status === 'deduplicated') p.run.counters.deduplicated++;
    else p.run.counters.failed++;
    return out;
  }

  /** Close the run: the unseen sweep (full runs), the delete policy, the bookkeeping. */
  async finish(
    companyId: string,
    p: { row: SourceConnectionRow; run: AgentRunState; req: FinishAgentRunRequest },
  ): Promise<SourceSyncSummary> {
    const { row, run, req } = p;
    const connectionId = String(row.id);
    let closed = 0;
    if (req.status === 'succeeded') {
      if (run.full) {
        for (;;) {
          const swept = await this.catalogue.markUnseenGone(companyId, {
            connectionId,
            runStartedAt: run.startedAt,
            goneAt: new Date(),
          });
          run.counters.gone += swept.length;
          if (swept.length < 500) break;
        }
      }
      const gone = await this.catalogue.goneSince(companyId, { connectionId, since: run.startedAt });
      closed = await this.effects.applyGone(companyId, row, gone);
      await this.connections.recordSync(companyId, connectionId, {
        status: 'succeeded',
        checkpoint: req.checkpoint ?? run.checkpoint ?? {},
      });
    } else {
      await this.connections.recordSync(companyId, connectionId, {
        status: 'failed',
        error: req.error ?? 'agent reported failure',
      });
    }
    return {
      connectionId,
      mode: run.full ? 'full' : 'incremental',
      status: req.status,
      ...run.counters,
      closed,
      durationMs: Date.now() - run.startedAt.getTime(),
      ...(req.error ? { error: req.error } : {}),
    };
  }

  private async viewOf(companyId: string, row: SourceConnectionRow): Promise<ConnectorConnectionView> {
    return this.connections.toConnectorView(row, await this.connections.sourceContext(companyId, row));
  }
}

/** The wire form of a fetched item back into the connector seam's shape. */
export function fromWire(w: FetchedItemWire): FetchedItem {
  switch (w.shape) {
    case 'document':
      return { shape: 'document', text: w.text, title: w.title, occurredAt: w.occurredAt, kind: w.kind };
    case 'binary': {
      const bytes = Buffer.from(w.bytesBase64, 'base64');
      if (bytes.length === 0) throw new BadRequestException('binary item carries no bytes');
      return { shape: 'binary', bytes, mediaType: w.mediaType, modality: w.modality, occurredAt: w.occurredAt };
    }
    case 'conversation':
      return { shape: 'conversation', conversationId: w.conversationId, turns: w.turns };
    case 'structure':
      return { shape: 'structure', record: w.record };
  }
}
