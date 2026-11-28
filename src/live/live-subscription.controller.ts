import {
  BadRequestException,
  Controller,
  Logger,
  Optional,
  Query,
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
import { PredicateRegistryService } from '../ai/predicate-registry.service';
import { LiveSubscriptionManager, type LiveEvent } from './live-subscription.manager';
import { captureLiveReadFence } from './live-read-fence';

/**
 * Realtime fact stream over SSE (flag `LIVE_SUBSCRIPTIONS_ENABLED`).
 *
 * Clients subscribe to BRAIN, never to SurrealDB: every event is fenced with
 * the caller's own identity — the per-user fence (`userId` as on every read:
 * a user-bound token reads global + its own rows, an M2M key global rows
 * plus the user it names in `?userId=`), the scope-tag / circle fence and the
 * row policy (predicate scope gate + ABAC). LIVE rows arrive raw and would
 * otherwise bypass all three; the identity is captured here, inside the
 * request, because it is gone by the time an event is pushed.
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

  constructor(
    private readonly live: LiveSubscriptionManager,
    @Optional() private readonly predicateRegistry?: PredicateRegistryService,
  ) {}

  @Sse('facts')
  @RequireScopes('brain:read')
  async facts(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('userId') userId?: unknown,
  ): Promise<Observable<{ data: LiveEvent }>> {
    if (!this.live.isEnabled()) {
      throw new ServiceUnavailableException('live subscriptions are disabled');
    }
    if (userId !== undefined && (typeof userId !== 'string' || userId.length === 0)) {
      throw new BadRequestException('userId must be a non-empty string');
    }
    // 403 here (before any socket) when a user-bound token names another user.
    const fence = captureLiveReadFence(userId);
    const companyId = req.brainAuth.companyId;
    const registry = this.predicateRegistry;
    const subject = new Subject<{ data: LiveEvent }>();
    const handle = await this.live.subscribe(companyId, {
      callerScopes: req.brainAuth.scopes,
      fence,
      sink: (event) => subject.next({ data: event }),
      ...(registry
        ? {
            policyLookup: await registry.rowPolicyLookup(companyId),
            warmPolicyLookup: () => registry.getSnapshot(companyId),
          }
        : {}),
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
    (req as unknown as { on(e: string, cb: () => void): void }).on('close', release);
    res.on('close', release);
    return subject.asObservable();
  }
}
