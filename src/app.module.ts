import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { HealthController } from './common/health.controller';
import { TenantThrottlerGuard } from './common/tenant-throttler.guard';
import { SurrealModule } from './db/surreal.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { IngestModule } from './ingest/ingest.module';
import { SearchModule } from './search/search.module';
import { SynthesizeModule } from './synthesize/synthesize.module';
import { MultiHopModule } from './multi-hop/multi-hop.module';
import { FactsModule } from './facts/facts.module';
import { EntitiesModule } from './entities/entities.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { McpModule } from './mcp/mcp.module';
import { CompactionModule } from './compaction/compaction.module';
import { DreamsModule } from './dreams/dreams.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Per-tenant throttling buckets. The default bucket is the
    // catch-all for unannotated routes. Each destructive / expensive
    // endpoint gets its own named bucket so a misbehaving tenant
    // can't starve cheap reads when their forget calls hit the
    // limit, and vice-versa.
    //
    // forget:    5/min   — leaked admin JWT blast radius
    // synthesize: 30/min  — gpt-4o-mini + Cohere costs
    // search:    60/min  — vector + BM25 hot path
    // ingest:    200/min — typical chat / check-in burst
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: parseInt(config.get<string>('THROTTLE_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_LIMIT', '120'), 10),
        },
        {
          name: 'forget',
          ttl: parseInt(config.get<string>('THROTTLE_FORGET_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_FORGET_LIMIT', '5'), 10),
        },
        {
          name: 'synthesize',
          ttl: parseInt(config.get<string>('THROTTLE_SYNTHESIZE_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_SYNTHESIZE_LIMIT', '30'), 10),
        },
        {
          name: 'search',
          ttl: parseInt(config.get<string>('THROTTLE_SEARCH_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_SEARCH_LIMIT', '60'), 10),
        },
        {
          name: 'ingest',
          ttl: parseInt(config.get<string>('THROTTLE_INGEST_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_INGEST_LIMIT', '200'), 10),
        },
      ],
    }),

    CommonModule,
    SurrealModule,
    AuthModule,
    AiModule,
    IngestModule,
    SearchModule,
    SynthesizeModule,
    MultiHopModule,
    FactsModule,
    EntitiesModule,
    ArtifactsModule,
    McpModule,
    CompactionModule,
    DreamsModule,
    MetricsModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: TenantThrottlerGuard,
    },
  ],
})
export class AppModule {}
