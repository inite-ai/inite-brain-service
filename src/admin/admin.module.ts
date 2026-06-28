import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { DreamsModule } from '../dreams/dreams.module';
import { IngestModule } from '../ingest/ingest.module';
import { SearchModule } from '../search/search.module';
import { FactsModule } from '../facts/facts.module';
import { EntitiesModule } from '../entities/entities.module';
import { AuditModule } from '../audit/audit.module';
import { CompactionModule } from '../compaction/compaction.module';
import { AdminController } from './admin.controller';
import { AdminDemoController } from './admin-demo.controller';
import { AdminEvalController } from './admin-eval.controller';
import { AdminPredicatesController } from './admin-predicates.controller';
import { AdminJobsController } from './admin-jobs.controller';
import { AdminOpsController } from './admin-ops.controller';
import { AdminInfraController } from './admin-infra.controller';
import { AdminInfraService } from './admin-infra.service';
import { HealthComponentsService } from './health-components.service';
import { LiveSnapshotService } from './live-snapshot.service';
import { DemoStateService } from './demo-state.service';
import { DemoPipelineService } from './demo-pipeline.service';
import { DemoChatService } from './demo-chat.service';
import { AdminService } from './admin.service';
import { OperatorActionService } from './operator-action.service';
import { OperatorActionInterceptor } from './operator-action.interceptor';
import { ThrottlerObservabilityService } from './throttler-observability.service';
import { ThrottlerObservabilityInterceptor } from './throttler-observability.interceptor';
import { ScenarioRunnerService } from './scenario-runner.service';
import { ScenarioWriteService } from './scenario-write.service';
import { ScenarioLifecycleService } from './scenario-lifecycle.service';
import { ScenarioEvalService } from './scenario-eval.service';
import { BaselineService } from './baseline.service';
import { ChatRouterService } from './chat-router.service';
import { ChatRouterCacheService } from './chat-router-cache.service';
import { CollapsePatternService } from './collapse-pattern.service';
import { IntentClassifierService } from './intent-classifier.service';
import { ConfigInspectorService } from './config-inspector.service';

@Module({
  imports: [
    AuthModule,
    DreamsModule,
    IngestModule,
    SearchModule,
    FactsModule,
    EntitiesModule,
    AuditModule,
    // AdminJobsController injects CompactionService for the
    // /admin/maintenance/compaction trigger. CompactionModule isn't
    // @Global, so without this import Nest fails to resolve the
    // controller and the whole app refuses to boot.
    CompactionModule,
  ],
  controllers: [
    AdminController,
    AdminDemoController,
    AdminEvalController,
    AdminPredicatesController,
    AdminJobsController,
    AdminOpsController,
    AdminInfraController,
  ],
  providers: [
    AdminService,
    AdminInfraService,
    HealthComponentsService,
    LiveSnapshotService,
    DemoStateService,
    DemoPipelineService,
    DemoChatService,
    ScenarioRunnerService,
    // Scenario-runner phase services (max-params split):
    ScenarioWriteService,
    ScenarioLifecycleService,
    ScenarioEvalService,
    BaselineService,
    ChatRouterCacheService,
    CollapsePatternService,
    IntentClassifierService,
    ChatRouterService,
    ConfigInspectorService,
    OperatorActionService,
    ThrottlerObservabilityService,
    {
      provide: APP_INTERCEPTOR,
      useClass: OperatorActionInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ThrottlerObservabilityInterceptor,
    },
  ],
})
export class AdminModule {}
