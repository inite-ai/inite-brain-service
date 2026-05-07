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
import { FactsModule } from './facts/facts.module';
import { EntitiesModule } from './entities/entities.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { McpModule } from './mcp/mcp.module';
import { CompactionModule } from './compaction/compaction.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: parseInt(config.get<string>('THROTTLE_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_LIMIT', '120'), 10),
        },
      ],
    }),

    CommonModule,
    SurrealModule,
    AuthModule,
    AiModule,
    IngestModule,
    SearchModule,
    FactsModule,
    EntitiesModule,
    ArtifactsModule,
    McpModule,
    CompactionModule,
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
