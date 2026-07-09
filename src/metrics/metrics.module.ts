import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MemoryQualityService } from './memory-quality.service';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  // MemoryQualityService's deps (SurrealService, ApiKeyService) come from
  // the global SurrealModule / AuthModule — no imports needed here.
  providers: [MetricsService, MemoryQualityService],
  exports: [MetricsService],
})
export class MetricsModule {}
