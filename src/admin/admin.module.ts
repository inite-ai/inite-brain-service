import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DreamsModule } from '../dreams/dreams.module';
import { IngestModule } from '../ingest/ingest.module';
import { SearchModule } from '../search/search.module';
import { FactsModule } from '../facts/facts.module';
import { EntitiesModule } from '../entities/entities.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ScenarioRunnerService } from './scenario-runner.service';
import { BaselineService } from './baseline.service';
import { ChatRouterService } from './chat-router.service';

@Module({
  imports: [
    AuthModule,
    DreamsModule,
    IngestModule,
    SearchModule,
    FactsModule,
    EntitiesModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    ScenarioRunnerService,
    BaselineService,
    ChatRouterService,
  ],
})
export class AdminModule {}
