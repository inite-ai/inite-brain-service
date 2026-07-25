import {
  Controller,
  Logger,
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable, Subject } from 'rxjs';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/api-key.types';
import {
  LiveSubscriptionManager,
  type LiveEvent,
} from './live-subscription.manager';

/**
 * Realtime fact stream over SSE (flag `LIVE_SUBSCRIPTIONS_ENABLED`).
 *
 * Clients subscribe to BRAIN, never to SurrealDB: the subscription is fenced
 * with the caller's own scopes on every event (see LiveSubscriptionManager —
 * LIVE rows arrive raw and would otherwise bypass the per-row policy gate that
 * every other read surface applies).
 *
 * SSE rather than a WebSocket deliberately: the stream is one-directional, SSE
 * survives proxies and reconnects natively, and it needs no new protocol
 * surface. The client resubscribes on disconnect; the manager's changefeed
 * catch-up covers the gap.
 */
@Controller('v1/live')
@UseGuards(ApiKeyGuard)
export class LiveSubscriptionController {
  private readonly logger = new Logger(LiveSubscriptionController.name);

  constructor(private readonly live: LiveSubscriptionManager) {}

  @Sse('facts')
  @RequireScopes('brain:read')
  async facts(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Observable<{ data: LiveEvent }>> {
    if (!this.live.isEnabled()) {
      throw new ServiceUnavailableException('live subscriptions are disabled');
    }
    const subject = new Subject<{ data: LiveEvent }>();
    const handle = await this.live.subscribe(req.brainAuth.companyId, {
      callerScopes: req.brainAuth.scopes,
      sink: (event) => subject.next({ data: event }),
    });
    // Client hang-up is the ONLY thing that releases the subscription — without
    // this the tenant's channel would never drop to zero subscribers and its
    // dedicated connection would leak for the life of the process.
    const release = () => {
      void handle.close().catch((e) => {
        this.logger.warn(`live unsubscribe failed: ${(e as Error).message}`);
      });
      subject.complete();
    };
    // AuthenticatedRequest is the auth-decorated view, not the Node stream
    // type; the runtime object is the express Request either way.
    (req as unknown as { on(e: string, cb: () => void): void }).on(
      'close',
      release,
    );
    res.on('close', release);
    return subject.asObservable();
  }
}
