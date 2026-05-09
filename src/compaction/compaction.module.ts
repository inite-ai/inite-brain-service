import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CompactionService, SUMMARY_GENERATOR } from './compaction.service';
import {
  ConcatSummaryGenerator,
  type SummaryGenerator,
} from './summary-generator';
import { LlmSummaryGenerator } from '../dreams/llm-summary.generator';
import { MetricsModule } from '../metrics/metrics.module';

/**
 * The SUMMARY_GENERATOR provider chooses between the no-LLM concat
 * fallback and the LLM-backed summarizer based on
 * DREAMS_LLM_SUMMARY_ENABLED. The runtime decision is made once at
 * boot — flipping the flag requires a restart.
 *
 * LlmSummaryGenerator itself ALSO falls back to concat behaviour on
 * any LLM failure, so the swap is safe: the worst case is the
 * existing concat output, never a hard error inside compaction.
 */
@Module({
  imports: [ScheduleModule.forRoot(), MetricsModule],
  providers: [
    CompactionService,
    {
      provide: SUMMARY_GENERATOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SummaryGenerator => {
        const llmEnabled =
          config.get<string>('DREAMS_LLM_SUMMARY_ENABLED', '0') === '1';
        return llmEnabled
          ? new LlmSummaryGenerator(config)
          : new ConcatSummaryGenerator();
      },
    },
  ],
  exports: [CompactionService, SUMMARY_GENERATOR],
})
export class CompactionModule {}
