import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { HealthController } from './common/health.controller';
import { SurrealModule } from './db/surreal.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';
import { IngestModule } from './ingest/ingest.module';
import { SearchModule } from './search/search.module';
import { FactsModule } from './facts/facts.module';
import { EntitiesModule } from './entities/entities.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 120,
    }]),

    CommonModule,
    SurrealModule,
    AuthModule,
    AiModule,
    IngestModule,
    SearchModule,
    FactsModule,
    EntitiesModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
