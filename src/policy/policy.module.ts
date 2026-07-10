import { Global, Module } from '@nestjs/common';
import { PolicyDecisionSink } from './policy-decision.sink';
import { PolicyGateService } from './policy-gate.service';
import { PolicyResolverService } from './policy-resolver.service';
import { PolicyStoreService } from './policy-store.service';

/**
 * ABAC wiring. Global because the resolver is consumed by ApiKeyGuard
 * (every guarded request) and the sink/store by admin + read surfaces
 * across modules — mirroring AuthModule/MetricsModule.
 */
@Global()
@Module({
  providers: [
    PolicyResolverService,
    PolicyStoreService,
    PolicyDecisionSink,
    PolicyGateService,
  ],
  exports: [
    PolicyResolverService,
    PolicyStoreService,
    PolicyDecisionSink,
    PolicyGateService,
  ],
})
export class PolicyModule {}
