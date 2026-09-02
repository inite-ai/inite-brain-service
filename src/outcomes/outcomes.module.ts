import { Module } from '@nestjs/common';
import { MemoryDecisionService } from './memory-decision.service';
import { MemoryOutcomeService } from './memory-outcome.service';
import { OutcomePruneService } from './outcome-prune.service';
import { ToolObservationService } from './tool-observation.service';

/**
 * Outcome telemetry (migration 0107): the append-only memory_outcome
 * event log + the memory_outcome_stat write-path rollup, behind ONE
 * write seam (MemoryOutcomeService), the decision-context writer
 * (MemoryDecisionService, 0119) plus the telemetry retention cron
 * (OutcomePruneService). Imported by the writer modules (search /
 * synthesize / feedback / ingest-core); every injection there is
 * @Optional so positionally-constructed unit fixtures stay valid.
 * SurrealService and ApiKeyService come from @Global modules.
 */
@Module({
  providers: [
    MemoryDecisionService,
    MemoryOutcomeService,
    OutcomePruneService,
    ToolObservationService,
  ],
  exports: [MemoryDecisionService, MemoryOutcomeService, ToolObservationService],
})
export class OutcomesModule {}
