import { Global, Module } from '@nestjs/common';
import { JevClient } from './jev.client';
import { DecisionService } from './decision.service';

/**
 * The decision plane. Global for the same reason the metrics module is: the
 * lanes that ask for a decision are scattered across ingest, search,
 * synthesize and the dream jobs, and threading a provider through every module
 * that happens to hold a judge is how the service ended up with thirteen
 * OpenAI clients once already.
 */
@Global()
@Module({
  providers: [JevClient, DecisionService],
  exports: [JevClient, DecisionService],
})
export class DecisionsModule {}
