import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DreamsModule } from '../dreams/dreams.module';
import { IngestModule } from '../ingest/ingest.module';
import { SearchModule } from '../search/search.module';
import { FactsModule } from '../facts/facts.module';
import { EntitiesModule } from '../entities/entities.module';
import { AdminController } from './admin.controller';
import { AdminDemoController } from './admin-demo.controller';
import { AdminEvalController } from './admin-eval.controller';
import { AdminPredicatesController } from './admin-predicates.controller';
import { AdminService } from './admin.service';
import { ScenarioRunnerService } from './scenario-runner.service';
import { BaselineService } from './baseline.service';
import { ChatRouterService } from './chat-router.service';
import { ChatRouterCacheService } from './chat-router-cache.service';
import { CollapsePatternService } from './collapse-pattern.service';
import { IntentClassifierService } from './intent-classifier.service';

@Module({
  imports: [
    AuthModule,
    DreamsModule,
    IngestModule,
    SearchModule,
    FactsModule,
    EntitiesModule,
  ],
  controllers: [
    AdminController,
    AdminDemoController,
    AdminEvalController,
    AdminPredicatesController,
  ],
  providers: [
    AdminService,
    ScenarioRunnerService,
    BaselineService,
    ChatRouterCacheService,
    CollapsePatternService,
    IntentClassifierService,
    ChatRouterService,
  ],
})
export class AdminModule {}
