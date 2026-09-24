import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { sourceWebhooksEnabled } from '../../common/source-plane-flags';
import type {
  WebhookApplySummary,
  WebhookReceipt,
  WebhookSetupResponse,
} from '../../contracts/source-plane/source-plane.schema';
import { idTailOf } from '../../ingest/ingest-utils';
import { JobClaimService } from '../../jobs/job-claim.service';
import { JobRunService } from '../../jobs/job-run.service';
import type { ConnectorCtx } from '../connector';
import { credentialCipherReady } from '../../common/secret-cipher';
import { resolveProvider } from '../oauth/oauth-providers';
import { SourceConnectionService, type SourceConnectionRow } from '../source-connection.service';
import { SourceItemEffectsService } from '../source-item-effects.service';
import { SourceItemService, type SourceItemRow } from '../source-item.service';
import { RecordsConnector, itemIdOf } from './records-connector';
import { signAddress, verifyAddress } from './webhook-address';
import type { WebhookEvent, WebhookRequest, WebhookScheme } from './webhook-schemes';

/** Events one call may carry; the rest are acknowledged and dropped (the next sync catches them). */
export const WEBHOOK_MAX_EVENTS = 100;
const WEBHOOK_PATH = '/v1/source-connections/webhook';
const APPLY_TIMEOUT_MS = 120_000;

export interface WebhookJobPayload {
  connectionId: string;
  webhook: { events: WebhookEvent[]; receivedAt: string };
}

/**
 * RecordsWebhookService — freshness for the records connectors
 * (docs/roadmap/crm-sources-2026-09.md § 4.4, W4.2c). A vendor that can
 * call a URL on change is pointed at the connection's ADDRESS
 * (tenant + connection under an HMAC, see webhook-address.ts); the call
 * is trusted the vendor's way (webhook-schemes.ts) and parsed into
 * "entity + id (+ deleted)" — nothing more. The engine then fetches
 * each named record through the connector's `get`, names its relation
 * targets, and hands it to the same records door a sync uses; a
 * deleted one closes its facts by the connection's delete policy. The
 * webhook never carries data into memory.
 *
 * The receipt is immediate: with a job queue the events become one
 * `source_sync` job (`ranBy: webhook`) and the vendor gets a 202 —
 * vendors time out in seconds and retry on anything else; without a
 * queue (a minimal deployment, the test app) the fetches run inline
 * under a bounded budget and the receipt carries the summary.
 */
@Injectable()
export class RecordsWebhookService {
  private readonly logger = new Logger(RecordsWebhookService.name);

  // eslint-disable-next-line max-params
  constructor(
    private readonly connections: SourceConnectionService,
    private readonly catalogue: SourceItemService,
    private readonly effects: SourceItemEffectsService,
    private readonly jobs: JobRunService,
    @Optional() private readonly claim?: JobClaimService,
  ) {}

  /** Switch the webhook on: a secret (generated, or the vendor's own), the address, the vendor's how-to. */
  async setup(
    companyId: string,
    p: { connectionId: string; secret?: string | undefined; baseUrl: string },
  ): Promise<WebhookSetupResponse> {
    this.assertEnabled();
    const row = await this.connections.load(companyId, p.connectionId);
    const connector = this.connections.resolveConnector(row);
    const scheme = schemeOf(connector);
    if (!scheme) {
      throw new BadRequestException(
        `connection ${p.connectionId} (${row.connector}) has no webhook lane`,
      );
    }
    if (row.shape !== 'structure' || row.host !== 'server') {
      throw new BadRequestException(`connection ${p.connectionId} cannot take a webhook`);
    }
    const secret = p.secret ?? randomBytes(24).toString('base64url');
    await this.connections.setWebhookSecret(companyId, p.connectionId, secret);
    const address = signAddress(companyId, idTailOf(p.connectionId));
    const bare = `${p.baseUrl.replace(/\/$/, '')}${WEBHOOK_PATH}/${address}`;
    const url = scheme.tokenInUrl ? `${bare}?token=${encodeURIComponent(secret)}` : bare;
    return {
      url,
      secret,
      scheme: scheme.id,
      notes: scheme.notes.map((n) => n.replace('{url}', url).replace('{secret}', secret)),
    };
  }

  async disable(companyId: string, connectionId: string): Promise<void> {
    this.assertEnabled();
    await this.connections.load(companyId, connectionId);
    await this.connections.setWebhookSecret(companyId, connectionId, null);
  }

  /**
   * The vendor's call. 404 for anything that is not an addressed, live,
   * webhook-enabled connection (nothing to enumerate), 401 for a call
   * the scheme does not trust, else the receipt.
   */
  async receive(address: string, req: WebhookRequest): Promise<WebhookReceipt> {
    if (!sourceWebhooksEnabled()) throw new NotFoundException();
    const target = verifyAddress(address);
    if (!target) throw new NotFoundException();
    const connectionId = `source_connection:${target.tail}`;
    const row = await this.connections.load(target.companyId, connectionId).catch(() => null);
    const secret = row ? this.connections.webhookSecretOf(row) : null;
    if (!row || !secret || row.status !== 'active' || row.host !== 'server') {
      throw new NotFoundException();
    }
    const connector = this.connections.resolveConnector(row);
    const scheme = schemeOf(connector);
    if (!scheme || !(connector instanceof RecordsConnector)) throw new NotFoundException();
    const appSecret = connector.oauth
      ? (resolveProvider(connector.oauth.provider)?.clientSecret ?? null)
      : null;
    if (!scheme.verify(req, { secret, appSecret: appSecret || null })) {
      throw new UnauthorizedException('webhook signature rejected');
    }
    await this.connections.touchWebhook(target.companyId, connectionId).catch(() => undefined);
    const parsed = scheme.events(req);
    const synced = new Set(connector.selectedEntities(row.config ?? {}).map((e) => e.type));
    const wanted = parsed.filter((e) => synced.has(e.entity));
    const distinct = dedupe(wanted);
    const events = distinct.slice(0, WEBHOOK_MAX_EVENTS);
    // Ignored = named an entity this connection does not sync, or fell past the cap; a repeat is one event.
    const receipt: WebhookReceipt = {
      accepted: events.length,
      ignored: parsed.length - wanted.length + (distinct.length - events.length),
      runId: null,
    };
    if (events.length === 0) return receipt;
    const payload: WebhookJobPayload = {
      connectionId,
      webhook: { events, receivedAt: new Date().toISOString() },
    };
    if (this.claim) {
      const digest = createHash('sha256')
        .update(JSON.stringify(events))
        .digest('base64url')
        .slice(0, 16);
      const job = await this.claim.enqueue({
        jobType: 'source_sync',
        companyId: target.companyId,
        triggeredBy: 'manual',
        triggeredByActor: `webhook:${scheme.id}`,
        dedupKey: `source_webhook_${target.tail}_${digest}`,
        payload: payload as unknown as Record<string, unknown>,
      });
      return { ...receipt, runId: job.runId };
    }
    const summary = await this.applyInline(target.companyId, payload, `webhook:${scheme.id}`);
    return { ...receipt, summary };
  }

  /** Inline (no queue): a job_run of its own, the receipt carries the summary. */
  private async applyInline(
    companyId: string,
    payload: WebhookJobPayload,
    actor: string,
  ): Promise<WebhookApplySummary> {
    const job = await this.jobs.start({
      jobType: 'source_sync',
      companyId,
      triggeredBy: 'manual',
      triggeredByActor: actor,
      initialProgress: {
        connectionId: payload.connectionId,
        webhook: true,
        events: payload.webhook.events.length,
      },
    });
    try {
      const summary = await this.apply(companyId, {
        ...payload,
        signal: AbortSignal.timeout(APPLY_TIMEOUT_MS),
      });
      await this.jobs.finish(job, {
        status: 'succeeded',
        result: { ...summary, ranBy: 'webhook' },
      });
      return summary;
    } catch (err) {
      await this.jobs.finish(job, {
        status: 'failed',
        error: { message: (err as Error).message ?? String(err) },
      });
      throw err;
    }
  }

  /**
   * Fetch what the events named — the queue's handler and the inline
   * path both end here. One run at the connector (its run cache names
   * relation targets across the batch), ended once.
   */
  async apply(
    companyId: string,
    p: WebhookJobPayload & { signal: AbortSignal },
  ): Promise<WebhookApplySummary> {
    const out: WebhookApplySummary = {
      connectionId: p.connectionId,
      received: p.webhook.events.length,
      fetched: 0,
      ingested: 0,
      deduplicated: 0,
      gone: 0,
      closed: 0,
      failed: 0,
      errors: [],
    };
    const row = await this.connections.load(companyId, p.connectionId);
    if (row.status !== 'active') throw new Error(`connection ${p.connectionId} is ${row.status}`);
    const connector = this.connections.resolveConnector(row);
    if (!(connector instanceof RecordsConnector)) {
      throw new Error(this.connections.connectorUnavailable(row));
    }
    const credential = await this.connections.credentialFor(companyId, row);
    const ctx: ConnectorCtx = {
      companyId,
      connection: this.connections.toConnectorView(row, {
        ...(await this.connections.sourceContext(companyId, row)),
        credential,
        grant: await this.connections.grantHints(companyId, row),
      }),
      signal: p.signal,
      log: (line) => this.logger.log(`[${p.connectionId}] ${line}`),
    };
    const goneRows: SourceItemRow[] = [];
    try {
      for (const event of p.webhook.events) {
        if (p.signal.aborted) throw new Error('aborted');
        await this.applyOne({ companyId, ctx, connector, row, event, out, goneRows });
      }
      out.closed = await this.effects.applyGone(companyId, row, goneRows);
    } finally {
      await connector.endRun(ctx).catch(() => undefined);
    }
    this.logger.log(
      `webhook ${p.connectionId} for ${companyId}: received=${out.received} fetched=${out.fetched} ingested=${out.ingested} deduplicated=${out.deduplicated} gone=${out.gone} closed=${out.closed} failed=${out.failed}`,
    );
    return out;
  }

  private async applyOne(p: {
    companyId: string;
    ctx: ConnectorCtx;
    connector: RecordsConnector;
    row: SourceConnectionRow;
    event: WebhookEvent;
    out: WebhookApplySummary;
    goneRows: SourceItemRow[];
  }): Promise<void> {
    const { companyId, ctx, connector, row, event, out } = p;
    const externalId = itemIdOf(event.entity, event.id);
    const markGone = async () => {
      const closed = await this.catalogue.markGoneByExternalId(companyId, {
        connectionId: String(row.id),
        externalId,
        at: new Date(),
      });
      if (closed) {
        out.gone++;
        p.goneRows.push(closed);
      }
    };
    try {
      if (event.deleted) {
        await markGone();
        return;
      }
      out.fetched++;
      const got = await connector.fetchRecord(ctx, event.entity, event.id);
      if (!got) {
        await markGone();
        return;
      }
      const upsert = await this.catalogue.upsertSeen(companyId, {
        connectionId: String(row.id),
        userId: row.userId ?? null,
        item: got.item,
        seenAt: new Date(),
      });
      if (!upsert.changed) {
        out.deduplicated++;
        return;
      }
      const r = await this.effects.ingestFetched({
        companyId,
        connection: ctx.connection,
        row: upsert.row,
        fetched: got.fetched,
      });
      if (r.status === 'ingested') out.ingested++;
      else if (r.status === 'deduplicated') out.deduplicated++;
      else {
        out.failed++;
        out.errors.push({ externalId, error: r.error ?? r.status });
      }
    } catch (e) {
      out.failed++;
      out.errors.push({ externalId, error: (e as Error).message });
    }
  }

  private assertEnabled(): void {
    if (!sourceWebhooksEnabled()) throw new NotFoundException();
    if (!credentialCipherReady()) {
      throw new BadRequestException(
        'SOURCE_CREDENTIAL_ENCRYPTION_KEY is unset — a webhook address is signed and its secret encrypted under it',
      );
    }
  }
}

function schemeOf(connector: unknown): WebhookScheme | null {
  return connector instanceof RecordsConnector ? (connector.webhook ?? null) : null;
}

/** The same record named twice in one call is fetched once; a deletion wins over an update. */
function dedupe(events: WebhookEvent[]): WebhookEvent[] {
  const byId = new Map<string, WebhookEvent>();
  for (const e of events) {
    const key = itemIdOf(e.entity, e.id);
    const prev = byId.get(key);
    if (!prev || e.deleted) byId.set(key, e);
  }
  return [...byId.values()];
}
