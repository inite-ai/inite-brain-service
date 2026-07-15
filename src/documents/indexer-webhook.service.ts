import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { envFlagEnabled } from '../common/env-validation';

/** Payload of the work_available push (also the HMAC-signed bytes). */
export interface WorkAvailableEvent {
  event: 'work_available';
  documentId: string;
  packId: string;
  packVersion: string;
  ts: string;
}

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BREAKER_MS = 5 * 60_000;

/**
 * Push side of external-indexer work discovery: when ingest routes a
 * document to a pack that declared `indexer.external.callbackUrl`,
 * Brain POSTs a signed work_available HINT there. Push is best-effort
 * by design — the pull API stays the source of truth, so a missed
 * webhook costs latency, never work. Consequently everything here is
 * fire-and-forget: never throws into the ingest path, retries a couple
 * of times, and latches a per-URL circuit breaker so a dead endpoint
 * can't slow-burn outbound sockets on every ingest.
 *
 * Signature: `X-Brain-Signature: sha256=<hex hmac>` over the raw JSON
 * body, keyed by the per-install webhook secret (0065, generated at
 * pack install and returned once in the install response).
 */
@Injectable()
export class IndexerWebhookService {
  private readonly logger = new Logger(IndexerWebhookService.name);
  /** callbackUrl → epoch-ms until which deliveries are skipped. */
  private readonly failedUntil = new Map<string, number>();

  constructor(private readonly surreal: SurrealService) {}

  /** Fire the hint; resolves when delivery settled (callers use `void`). */
  async notifyWorkAvailable(p: {
    companyId: string;
    documentId: string;
    packId: string;
    packVersion: string;
    callbackUrl: string;
  }): Promise<void> {
    if (!envFlagEnabled(process.env.INDEXER_WEBHOOK_PUSH_ENABLED ?? '1')) {
      return;
    }
    const until = this.failedUntil.get(p.callbackUrl) ?? 0;
    if (Date.now() < until) return;

    try {
      const secret = await this.webhookSecret(p.companyId, p.packId);
      if (!secret) {
        // Builtin packs and pre-0065 installs have no secret; unsigned
        // pushes are worse than none (the receiver can't authenticate
        // them), so skip — reinstalling the pack mints a secret.
        this.logger.debug(
          `no webhook secret for pack ${p.packId} — push skipped (poll still works)`,
        );
        return;
      }
      const body: WorkAvailableEvent = {
        event: 'work_available',
        documentId: p.documentId,
        packId: p.packId,
        packVersion: p.packVersion,
        ts: new Date().toISOString(),
      };
      const ok = await this.deliver(p.callbackUrl, body, secret);
      if (!ok) {
        this.failedUntil.set(p.callbackUrl, Date.now() + BREAKER_MS);
        this.logger.warn(
          `webhook delivery to ${p.callbackUrl} failed for pack ${p.packId} — breaker latched ${BREAKER_MS / 1000}s`,
        );
      }
    } catch (e) {
      // Absolute backstop — a push must never surface into ingest.
      this.logger.warn(
        `webhook push for pack ${p.packId} threw: ${(e as Error).message}`,
      );
    }
  }

  private async deliver(
    url: string,
    body: WorkAvailableEvent,
    secret: string,
  ): Promise<boolean> {
    const payload = JSON.stringify(body);
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(retryBaseMs() * 4 ** (attempt - 1));
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-brain-event': body.event,
              'x-brain-signature': `sha256=${signature}`,
            },
            body: payload,
            signal: ctrl.signal,
          });
          if (res.ok) return true;
          // A 4xx is the endpoint REJECTING the event — retrying the same
          // bytes can't help; latch the breaker via the false return.
          if (res.status < 500) return false;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // network error / timeout — retry
      }
    }
    return false;
  }

  private async webhookSecret(
    companyId: string,
    packId: string,
  ): Promise<string | null> {
    return this.surreal.withCompany(companyId, async (db) => {
      const [rows] = await db.query<[any[]]>(
        `SELECT webhookSecret FROM domain_pack
           WHERE packId = $packId AND status = 'active' LIMIT 1`,
        { packId },
      );
      const secret = ((rows as any[]) ?? [])[0]?.webhookSecret;
      return secret ? String(secret) : null;
    });
  }
}

function retryBaseMs(): number {
  const v = Number(process.env.INDEXER_WEBHOOK_RETRY_BASE_MS);
  return Number.isFinite(v) && v > 0 ? v : 250;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
