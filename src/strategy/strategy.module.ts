import { Module } from '@nestjs/common';
import { StrategyMemoryService } from './strategy-memory.service';
import { StrategyDistillService } from './strategy-distill.service';
import { StrategyAdminController } from './strategy-admin.controller';

/**
 * Strategy-memory lane (G4) + distill/lifecycle cron (G7 host).
 * SurrealService / EmbedderService / ApiKeyService arrive via the
 * global modules; StrategyMemoryService is exported for the
 * synthesize-side evidence collector (@Optional dep).
 */
@Module({
  controllers: [StrategyAdminController],
  providers: [StrategyMemoryService, StrategyDistillService],
  exports: [StrategyMemoryService],
})
export class StrategyModule {}
