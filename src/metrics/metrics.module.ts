import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MemoryQualityService } from './memory-quality.service';
import { CapabilityProbeService } from './capability-probe.service';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  // MemoryQualityService's deps (SurrealService, ApiKeyService) come from
  // the global SurrealModule / AuthModule — no imports needed here.
  // CapabilityProbeService adds EmbedderService (global AiModule), injected
  // @Optional() so a process without it still probes the read path.
  providers: [MetricsService, MemoryQualityService, CapabilityProbeService],
  exports: [MetricsService, CapabilityProbeService],
})
export class MetricsModule {}
