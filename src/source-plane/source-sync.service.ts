import { Injectable, Logger } from '@nestjs/common';
import { sourcePlaneEnabled } from '../common/source-plane-flags';
import type { SourceSyncSummary } from '../contracts/source-plane/source-plane.schema';
import type { Connector, ConnectorCtx, ItemDelta } from './connector';
import { SourceConnectionService, type SourceConnectionRow } from './source-connection.service';
import { SourceItemEffectsService } from './source-item-effects.service';
import { SourceItemService, type SourceItemRow } from './source-item.service';

export interface SyncOptions {
  /** Re-enumerate everything and mark what is missing gone. */
  full?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

/** Items enumerated per run before the engine stops and checkpoints. */
const ENUMERATE_HARD_CAP = 50_000;

/**
 * SourceSyncService — the engine (raw-evidence-sources-2026-09.md
 * § 5.4), one connection per run:
 *
 *   1. enumerate from the stored checkpoint (null ⇒ full walk) and
 *      upsert every descriptor into the catalogue;
 *   2. diff: new / changed (revision moved past the fetched one) /
 *      unchanged / gone (explicit on incremental runs; anything the
 *      walk did not touch on full runs);
 *   3. fetch by policy — `manifest` writes nothing but the row; `text`
 *      and `bytes` fetch every changed item, bounded by `fetchBudget`,
 *      through the door for the item's shape (SourceItemEffectsService);
 *   4. drift: each fetch carries the item's revision stamp, and the
 *      existing sweep marks facts read at older revisions stale;
 *   5. gone: the connection's deletePolicy closes what the item grounded;
 *   6. bookkeeping: checkpoint, lastSyncAt, counters (the job result).
 *
 * Idempotent on (connection, externalId, revision): a re-run over an
 * unchanged source is 0 fetches, 0 LLM calls, 0 writes beyond
 * lastSeenAt — the repo-indexer's contract, engine-wide. Every early
 * exit is a named `skipped`; a connector that throws mid-walk fails the
 * run without losing the catalogue rows it already wrote.
 */
@Injectable()
export class SourceSyncService {
  private readonly logger = new Logger(SourceSyncService.name);

  constructor(
    private readonly connections: SourceConnectionService,
    private readonly catalogue: SourceItemService,
    private readonly effects: SourceItemEffectsService,
  ) {}

  /** Exposed for the scheduler (which holds no connection service of its own). */
  dueConnections(companyId: string, now: Date): Promise<SourceConnectionRow[]> {
    return this.connections.due(companyId, now);
  }

  async sync(
    companyId: string,
    connectionId: string,
    opts: SyncOptions = {},
  ): Promise<SourceSyncSummary> {
    const started = Date.now();
    const base = (mode: SourceSyncSummary['mode']): SourceSyncSummary => ({
      connectionId,
      mode,
      status: 'skipped',
      seen: 0,
      new: 0,
      changed: 0,
      unchanged: 0,
      gone: 0,
      fetched: 0,
      ingested: 0,
      deduplicated: 0,
      failed: 0,
      closed: 0,
      durationMs: 0,
    });
    if (!sourcePlaneEnabled()) return { ...base('incremental'), skipped: 'flag_off' };
    const row = await this.connections.load(companyId, connectionId);
    if (row.status !== 'active') return { ...base('incremental'), skipped: `status_${row.status}` };
    if (row.host !== 'server') return { ...base('incremental'), skipped: 'agent_host' };
    const connector = this.connections.resolveConnector(row);
    if (!connector) {
      const error = this.connections.connectorUnavailable(row);
      await this.connections.recordSync(companyId, connectionId, { status: 'failed', error });
      return { ...base('incremental'), status: 'failed', error };
    }
    const full = opts.full === true || row.checkpoint == null || connector.walksEverything === true;
    const summary = base(full ? 'full' : 'incremental');
    const runStartedAt = new Date();
    // The credential is resolved before the run — a revoked account, a
    // refresh the provider refused, a missing key — is the run's named
    // failure, not an exception out of the job.
    let credential: string | null;
    try {
      credential = await this.connections.credentialFor(companyId, row);
    } catch (err) {
      const error = (err as Error).message ?? String(err);
      await this.connections.recordSync(companyId, connectionId, { status: 'failed', error });
      return { ...summary, status: 'failed', error };
    }
    const ctx: ConnectorCtx = {
      companyId,
      connection: this.connections.toConnectorView(row, {
        ...(await this.connections.sourceContext(companyId, row)),
        credential,
      }),
      signal: opts.signal ?? new AbortController().signal,
      log: (line) => this.logger.log(`[${connectionId}] ${line}`),
    };
    let checkpoint: Record<string, unknown> | null = full ? null : (row.checkpoint ?? null);
    const toFetch: SourceItemRow[] = [];
    const goneRows: SourceItemRow[] = [];
    try {
      const walk = await this.enumerate({
        companyId,
        ctx,
        connector,
        row,
        full,
        summary,
        toFetch,
        goneRows,
        runStartedAt,
      });
      if (walk.checkpoint !== undefined) checkpoint = walk.checkpoint;
      if (full) {
        for (;;) {
          const closed = await this.catalogue.markUnseenGone(companyId, {
            connectionId,
            runStartedAt,
            goneAt: new Date(),
          });
          if (closed.length === 0) break;
          goneRows.push(...closed);
          summary.gone += closed.length;
          if (closed.length < 500) break;
        }
      }
      await this.fetchChanged({ companyId, ctx, connector, row, summary, toFetch });
      summary.closed = await this.gonePolicy(companyId, row, goneRows);
      summary.status = 'succeeded';
      await this.connections.recordSync(companyId, connectionId, {
        status: 'succeeded',
        checkpoint: checkpoint ?? {},
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      summary.status = 'failed';
      summary.error = message;
      this.logger.warn(`source sync ${connectionId} failed for ${companyId}: ${message}`);
      await this.connections
        .recordSync(companyId, connectionId, { status: 'failed', error: message })
        .catch(() => undefined);
    } finally {
      // A session the connector held across the run (an MCP client) ends
      // with the run; a failure to close is logged, never a run failure.
      await connector.endRun?.(ctx).catch((e: unknown) => {
        this.logger.warn(`source sync ${connectionId}: endRun failed: ${(e as Error).message}`);
      });
    }
    summary.durationMs = Date.now() - started;
    this.logger.log(
      `source sync ${connectionId} for ${companyId}: ${summary.status} seen=${summary.seen} new=${summary.new} changed=${summary.changed} gone=${summary.gone} fetched=${summary.fetched} ingested=${summary.ingested} deduplicated=${summary.deduplicated} failed=${summary.failed} closed=${summary.closed} in ${summary.durationMs}ms`,
    );
    return summary;
  }

  private async enumerate(p: {
    companyId: string;
    ctx: ConnectorCtx;
    connector: Connector;
    row: SourceConnectionRow;
    full: boolean;
    summary: SourceSyncSummary;
    toFetch: SourceItemRow[];
    goneRows: SourceItemRow[];
    runStartedAt: Date;
  }): Promise<{ checkpoint?: Record<string, unknown> }> {
    let checkpoint: Record<string, unknown> | undefined;
    const startingPoint = p.full ? null : (p.row.checkpoint ?? null);
    let count = 0;
    for await (const delta of p.connector.enumerate(p.ctx, {
      checkpoint: startingPoint,
      full: p.full,
    })) {
      if (p.ctx.signal.aborted) throw new Error('aborted');
      if (++count > ENUMERATE_HARD_CAP)
        throw new Error(`enumerate exceeded ${ENUMERATE_HARD_CAP} deltas`);
      await this.applyDelta({ ...p, delta, onCheckpoint: (c) => (checkpoint = c) });
    }
    return checkpoint === undefined ? {} : { checkpoint };
  }

  private async applyDelta(p: {
    companyId: string;
    row: SourceConnectionRow;
    delta: ItemDelta;
    summary: SourceSyncSummary;
    toFetch: SourceItemRow[];
    goneRows: SourceItemRow[];
    runStartedAt: Date;
    onCheckpoint: (c: Record<string, unknown>) => void;
  }): Promise<void> {
    const { delta, summary } = p;
    if (delta.type === 'checkpoint') {
      p.onCheckpoint(delta.checkpoint);
      return;
    }
    if (delta.type === 'gone') {
      const closed = await this.catalogue.markGoneByExternalId(p.companyId, {
        connectionId: String(p.row.id),
        externalId: delta.externalId,
        at: new Date(),
      });
      if (closed) {
        summary.gone++;
        p.goneRows.push(closed);
      }
      return;
    }
    summary.seen++;
    const out = await this.catalogue.upsertSeen(p.companyId, {
      connectionId: String(p.row.id),
      userId: p.row.userId ?? null,
      item: delta.item,
      seenAt: p.runStartedAt,
    });
    if (out.isNew) summary.new++;
    else if (out.changed) summary.changed++;
    else summary.unchanged++;
    if (out.changed) p.toFetch.push(out.row);
  }

  private async fetchChanged(p: {
    companyId: string;
    ctx: ConnectorCtx;
    connector: Connector;
    row: SourceConnectionRow;
    summary: SourceSyncSummary;
    toFetch: SourceItemRow[];
  }): Promise<void> {
    if (p.row.contentPolicy === 'manifest') return;
    const budget = p.row.fetchBudget ?? Number.POSITIVE_INFINITY;
    for (const item of p.toFetch) {
      if (p.summary.fetched >= budget) break;
      if (p.ctx.signal.aborted) throw new Error('aborted');
      p.summary.fetched++;
      const out = await this.effects.fetchAndIngest({
        companyId: p.companyId,
        ctx: p.ctx,
        connector: p.connector,
        row: item,
      });
      if (out.status === 'ingested') p.summary.ingested++;
      else if (out.status === 'deduplicated') p.summary.deduplicated++;
      else p.summary.failed++;
    }
  }

  private gonePolicy(
    companyId: string,
    row: SourceConnectionRow,
    gone: SourceItemRow[],
  ): Promise<number> {
    return this.effects.applyGone(companyId, row, gone);
  }
}
