import { Global, Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { SourcesModule } from '../sources/sources.module';
import { PolicyDecisionSink } from './policy-decision.sink';
import { PolicyDecisionsService } from './policy-decisions.service';
import { PolicyGateService } from './policy-gate.service';
import { PolicyKeysService } from './policy-keys.service';
import { PolicyRegistryService } from './policy-registry.service';
import { PolicyResolverService } from './policy-resolver.service';
import { PolicySimulationService } from './policy-simulation.service';
import { PolicyStoreService } from './policy-store.service';

/**
 * ABAC wiring. Global because the resolver is consumed by ApiKeyGuard
 * (every guarded request) and the sink/store by admin + read surfaces
 * across modules — mirroring AuthModule/MetricsModule.
 *
 * SearchModule powers the simulation surface (real pipeline runs);
 * SourcesModule feeds the registry's vertical/recorder autocomplete.
 */
@Global()
@Module({
  imports: [SearchModule, SourcesModule],
  providers: [
    PolicyResolverService,
    PolicyStoreService,
    PolicyDecisionSink,
    PolicyGateService,
    PolicyKeysService,
    PolicyRegistryService,
    PolicySimulationService,
    PolicyDecisionsService,
  ],
  exports: [
    PolicyResolverService,
    PolicyStoreService,
    PolicyDecisionSink,
    PolicyGateService,
    PolicyKeysService,
    PolicyRegistryService,
    PolicySimulationService,
    PolicyDecisionsService,
  ],
})
export class PolicyModule {}
