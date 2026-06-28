import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { HealthController } from './common/health.controller';
import { HealthService } from './common/health.service';
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
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { JobsModule } from './jobs/jobs.module';
import { CommunityModule } from './communities/community.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Two named throttlers:
    //   default   — every route. Generous cap for cheap reads / writes.
    //   expensive — opt-in via @Throttle({ expensive: { … } }) on routes
    //               that fan out to OpenAI (synthesize, multi-hop, ingest-
    //               mention, demo-chat, dreams). Tight cap so a single
    //               compromised tenant can't drain the shared OpenAI
    //               token budget.
    // Both buckets key by Bearer token (see TenantThrottlerGuard), so the
    // expensive limit is per-credential, not per-IP — NAT'd tenants don't
    // shadow each other.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          name: 'default',
          ttl: parseInt(config.get<string>('THROTTLE_TTL_MS', '60000'), 10),
          limit: parseInt(config.get<string>('THROTTLE_LIMIT', '120'), 10),
        },
        {
          name: 'expensive',
          ttl: parseInt(
            config.get<string>('THROTTLE_EXPENSIVE_TTL_MS', '60000'),
            10,
          ),
          limit: parseInt(
            config.get<string>('THROTTLE_EXPENSIVE_LIMIT', '10'),
            10,
          ),
        },
      ],
    }),

    // Registered once at the root. `@Cron`/`@Interval` providers in any
    // feature module are picked up by the global SchedulerOrchestrator —
    // feature modules must NOT call forRoot() again (duplicate registration).
    ScheduleModule.forRoot(),

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
    AdminModule,
    AuditModule,
    JobsModule,
    CommunityModule,
    StatsModule,
  ],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: APP_GUARD,
      useClass: TenantThrottlerGuard,
    },
  ],
})
export class AppModule {}
