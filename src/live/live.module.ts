import { Module } from '@nestjs/common';
import { LiveSubscriptionManager } from './live-subscription.manager';
import { LiveSubscriptionController } from './live-subscription.controller';

/**
 * Realtime fact subscriptions (`LIVE_SUBSCRIPTIONS_ENABLED`, default off).
 *
 * Deliberately NOT part of SurrealModule even though the manager owns Surreal
 * connections: those connections live OUTSIDE both pools (a `LIVE SELECT` must
 * be held, which acquire-switch-release cannot do), and a controller may not
 * import from `src/db` — layer purity. Keeping the pair here makes the
 * subscription surface a feature module with its own lifecycle.
 *
 * Inert while the flag is off: no socket is opened until the first subscriber
 * arrives, and the controller answers 503.
 */
@Module({
  providers: [LiveSubscriptionManager],
  controllers: [LiveSubscriptionController],
  exports: [LiveSubscriptionManager],
})
export class LiveModule {}
