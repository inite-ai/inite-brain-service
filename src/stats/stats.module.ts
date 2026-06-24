import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * StatsModule — read-only per-company memory counts for the end-user
 * Usage page. SurrealService comes from the @Global SurrealModule.
 */
@Module({
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
