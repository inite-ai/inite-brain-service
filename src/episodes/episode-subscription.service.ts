import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Surreal } from 'surrealdb';
import { StringRecordId } from 'surrealdb';
import { SurrealService } from '../db/surreal.service';
import { ApiKeyService } from '../auth/api-key.service';
import { LeaderLeaseService } from '../jobs/leader-lease.service';
import { envFlagEnabled } from '../common/env-validation';
import { EpisodeReadStoreService } from './episode-read-store.service';

export interface EpisodeSubscriptionRow {
  id: string;
  url: string;
  active: boolean;
  watermark: string;
  failureCount: number;
  createdAt: string;
}

/** The HMAC-signed push body (metadata only — never episode text). */
export interface EpisodesAvailableEvent {
  event: 'episodes_available';
  /** Delivery is at-least-once; consumers dedupe on episode ids. */
  delivery: 'at-least-once';
  episodes: Array<{
    id: string;
    conversationId?: string;
    messageId: string;
    speaker?: string;
    occurredAt: string;
    recordedAt: string;
  }>;
  /** The new watermark this batch advances to (max recordedAt). */
  watermark: string;
  ts: string;
}

const BATCH_CAP = 200;
const DELIVERY_TIMEOUT_MS = 5_000;
const BREAKER_MS = 5 * 60_000;
/** Consecutive failures after which a subscription self-deactivates. */
const MAX_FAILURES = 100;

/**
 * Raw-substrate driver v1, surface 4
 * (docs/roadmap/raw-substrate-driver-2026-08.md): new-episode webhook
 * push for external projection builders.
 *
 * Watermark-POLL dispatcher, deliberately not changefeed-driven — 0073
 * keeps the episode table feed-free for GDPR reasons. Watermarks track
 * recordedAt (ingest time, monotone; occurredAt can be backdated). The
 * payload is METADATA ONLY, so no PII crosses this surface; subscribers
 * pull bodies through GET /v1/episodes under their own scopes.
 *
 * Delivery semantics: at-least-once. The watermark advances via CAS
 * only after a 2xx, so a crash between delivery and advance re-sends
 * the batch; concurrent pods double-send at worst (the CAS keeps the
 * watermark itself consistent). Signature mirrors the indexer webhook:
 * `X-Brain-Signature: sha256=<hex hmac>` over the raw JSON body.
 */
@Injectable()
export class EpisodeSubscriptionService {
  private readonly logger = new Logger(EpisodeSubscriptionService.name);
  /**
   * subscription id → epoch-ms until which deliveries are skipped.
   * Keyed per SUBSCRIPTION, not per URL (audit W1): two tenants may
   * register the same endpoint, and one tenant's dead receiver must not
   * mute the other's pushes.
   */
  private readonly failedUntil = new Map<string, number>();

  // eslint-disable-next-line max-params
  constructor(
    private readonly surreal: SurrealService,
    private readonly episodes: EpisodeReadStoreService,
    private readonly apiKeys: ApiKeyService,
    @Optional() private readonly lease?: LeaderLeaseService,
  ) {}

  static enabled(): boolean {
    return envFlagEnabled(process.env.EPISODE_SUBSCRIPTIONS_ENABLED);
  }

  /** Register an endpoint; the signing secret is returned exactly once. */
  async create(
    companyId: string,
    url: string,
  ): Promise<{ id: string; secret: string; watermark: string }> {
    const secret = randomBytes(32).toString('hex');
    const watermark = new Date().toISOString();
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `CREATE episode_subscription SET
           url = $url, secret = $secret, active = true,
           watermark = <datetime> $watermark, failureCount = 0`,
        { url, secret, watermark },
      );
      const id = String(rows?.[0]?.id ?? '');
      if (!id) throw new Error('subscription create returned no id');
      return { id, secret, watermark };
    });
  }

  /** Registered endpoints, secrets never included. */
  async list(companyId: string): Promise<EpisodeSubscriptionRow[]> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [Array<EpisodeSubscriptionRow & { id: unknown }>]
      >(
        `SELECT id, url, active, watermark, failureCount, createdAt
           FROM episode_subscription ORDER BY createdAt ASC`,
      );
      return (rows ?? []).map((r) => ({ ...r, id: String(r.id) }));
    });
  }

  async remove(companyId: string, id: string): Promise<boolean> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `DELETE $id RETURN BEFORE`,
        { id: new StringRecordId(id) },
      );
      return (rows ?? []).length > 0;
    });
  }

  /**
   * One dispatch pass over every tenant. Runs each minute wherever the
   * flag is on — enable it on ONE role (the worker) in prod; duplicate
   * pods only risk duplicate pushes, never watermark corruption (CAS).
   */
  @Cron('* * * * *')
  async dispatchTick(): Promise<void> {
    if (!EpisodeSubscriptionService.enabled()) return;
    // One dispatcher per deployment (audit W1): without this every pod
    // scans every tenant each minute and double-pushes the same batch.
    // ttl=180s = 3x the cron cadence, same headroom as the changefeed
    // consumer. Absent lease service (single-process deploys) → run.
    if (this.lease) {
      const got = await this.lease.tryAcquire('episode_subscriptions', 180);
      if (!got) return;
    }
    for (const companyId of this.apiKeys.knownCompanyIds()) {
      try {
        await this.dispatchCompany(companyId);
      } catch (e) {
        this.logger.warn(
          `episode-subscription dispatch failed (companyId=${companyId}): ${(e as Error).message}`,
        );
      }
    }
  }

  private async dispatchCompany(companyId: string): Promise<void> {
    const subs = await this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<
        [
          Array<{
            id: unknown;
            url: string;
            secret: string;
            watermark: Date | string;
            failureCount: number;
          }>,
        ]
      >(
        `SELECT id, url, secret, watermark, failureCount
           FROM episode_subscription WHERE active = true`,
      );
      return rows ?? [];
    });
    for (const sub of subs) {
      const subKey = String(sub.id);
      const until = this.failedUntil.get(subKey) ?? 0;
      if (Date.now() < until) continue;
      const sinceIso = new Date(sub.watermark as string).toISOString();
      const rows = await this.episodes.metaSince({
        companyId,
        sinceIso,
        limit: BATCH_CAP,
      });
      if (rows.length === 0) continue;
      const toIso = (v: Date | string): string => new Date(v as string).toISOString();
      const watermark = toIso(rows[rows.length - 1]!.recordedAt); // rows non-empty (checked)
      const event: EpisodesAvailableEvent = {
        event: 'episodes_available',
        delivery: 'at-least-once',
        episodes: rows.map((r) => ({
          id: String(r.id),
          ...(r.conversationId ? { conversationId: r.conversationId } : {}),
          messageId: r.messageId,
          ...(r.speaker ? { speaker: r.speaker } : {}),
          occurredAt: toIso(r.occurredAt),
          recordedAt: toIso(r.recordedAt),
        })),
        watermark,
        ts: new Date().toISOString(),
      };
      const ok = await this.deliver({
        subKey,
        url: sub.url,
        secret: sub.secret,
        event,
      });
      await this.settle({
        companyId,
        sub,
        ok,
        previousWatermarkIso: sinceIso,
        newWatermarkIso: watermark,
      });
    }
  }

  private async deliver({
    subKey,
    url,
    secret,
    event,
  }: {
    subKey: string;
    url: string;
    secret: string;
    event: EpisodesAvailableEvent;
  }): Promise<boolean> {
    const body = JSON.stringify(event);
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Brain-Signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (res.ok) {
        this.failedUntil.delete(subKey);
        return true;
      }
      this.logger.warn(`episode push to ${url} → HTTP ${res.status}`);
    } catch (e) {
      this.logger.warn(`episode push to ${url} failed: ${(e as Error).message}`);
    }
    this.failedUntil.set(subKey, Date.now() + BREAKER_MS);
    return false;
  }

  private async settle({
    companyId,
    sub,
    ok,
    previousWatermarkIso,
    newWatermarkIso,
  }: {
    companyId: string;
    sub: { id: unknown; failureCount: number };
    ok: boolean;
    previousWatermarkIso: string;
    newWatermarkIso: string;
  }): Promise<void> {
    await this.surreal.withCompany(companyId, async (db: Surreal) => {
      if (ok) {
        // CAS: only advance from the watermark this batch was read at —
        // a concurrent pod that already advanced wins, we no-op.
        await db.query(
          `UPDATE $id SET watermark = <datetime> $new, failureCount = 0
            WHERE watermark = <datetime> $old`,
          {
            id: new StringRecordId(String(sub.id)),
            new: newWatermarkIso,
            old: previousWatermarkIso,
          },
        );
        return;
      }
      const failures = sub.failureCount + 1;
      await db.query(
        failures >= MAX_FAILURES
          ? `UPDATE $id SET failureCount = $n, active = false`
          : `UPDATE $id SET failureCount = $n`,
        { id: new StringRecordId(String(sub.id)), n: failures },
      );
      if (failures >= MAX_FAILURES) {
        this.logger.warn(
          `episode subscription ${String(sub.id)} deactivated after ${failures} failures`,
        );
      }
    });
  }
}
