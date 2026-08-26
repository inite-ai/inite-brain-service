import { Module } from '@nestjs/common';
import { MemoryOutcomeService } from './memory-outcome.service';
import { OutcomePruneService } from './outcome-prune.service';

/**
 * Outcome telemetry (migration 0107): the append-only memory_outcome
 * event log + the memory_outcome_stat write-path rollup, behind ONE
 * write seam (MemoryOutcomeService) plus the raw-log retention cron
 * (OutcomePruneService). Imported by the writer modules (search /
 * synthesize / feedback / ingest-core); every injection there is
 * @Optional so positionally-constructed unit fixtures stay valid.
 * SurrealService and ApiKeyService come from @Global modules.
 */
@Module({
  providers: [MemoryOutcomeService, OutcomePruneService],
  exports: [MemoryOutcomeService],
})
export class OutcomesModule {}
