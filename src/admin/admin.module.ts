import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { DreamsModule } from '../dreams/dreams.module';
import { IngestModule } from '../ingest/ingest.module';
import { SearchModule } from '../search/search.module';
import { FactsModule } from '../facts/facts.module';
import { EntitiesModule } from '../entities/entities.module';
import { AuditModule } from '../audit/audit.module';
import { EpisodesModule } from '../episodes/episodes.module';
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
import { AdminPacksController } from './admin-packs.controller';
import { AdminPoliciesController } from './admin-policies.controller';
import { AdminPolicyController } from './admin-policy.controller';
import { AdminPolicyDecisionsController } from './admin-policy-decisions.controller';
import { AdminKeysController } from './admin-keys.controller';
import { AdminCodeMemoryController } from './admin-code-memory.controller';
import { AdminHnswController } from './admin-hnsw.controller';
import { AdminEmbeddingSpaceController } from './admin-embedding-space.controller';
import { AdminAggregatesController } from './admin-aggregates.controller';
import { AggregateComposerService } from './aggregate-composer.service';
import { ArcComposerService } from './arc-composer.service';
import { AdminDeriveController } from './admin-derive.controller';
import { ProjectionsController } from './projections.controller';
import { WindowDeriverService } from './window-deriver.service';
import { AdminSegmentsController } from './admin-segments.controller';
import { SegmentComposerService } from './segment-composer.service';
import { SegmentBackfillService } from './segment-backfill.service';
import { AdminScenesController } from './admin-scenes.controller';
import { SceneComposerService } from './scene-composer.service';
import { SceneEnricherService } from './scene-enricher.service';
import { SceneBacklinkService } from './scene-backlink.service';
import { BeliefPromotionService } from './belief-promotion.service';
import { SceneVersionService } from './scene-version';
import { HnswMaintenanceService } from './hnsw-maintenance.service';
import { CodeMemoryModule } from '../code-memory/code-memory.module';
import { RegistryModule } from '../registry/registry.module';
import { IndexersModule } from '../indexers/indexers.module';
import { McpModule } from '../mcp/mcp.module';
import { DomainPackInstallService } from './domain-pack-install.service';
import { PackEvalService } from './pack-eval.service';
import { ScenarioRunnerService } from './scenario-runner.service';
import { ScenarioWriteService } from './scenario-write.service';
import { ScenarioLifecycleService } from './scenario-lifecycle.service';
import { ScenarioEvalService } from './scenario-eval.service';
import { BaselineService } from './baseline.service';
import { ChatRouterService } from './chat-router.service';
import { ChatRouterLlmService } from './chat-router-llm.service';
import { ChatRoutePlannerService } from './chat-route-planner.service';
import { PredicatePlanService } from './predicate-plan.service';
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
    EpisodesModule,
    // AdminJobsController injects CompactionService for the
    // /admin/maintenance/compaction trigger. CompactionModule isn't
    // @Global, so without this import Nest fails to resolve the
    // controller and the whole app refuses to boot.
    CompactionModule,
    CodeMemoryModule,
    // AdminPacksController resolves manifests from the global registry for
    // POST /v1/admin/packs/from-registry.
    RegistryModule,
    // PackEvalService scores fixtures in 'dedicated' mode through the
    // pack-scoped extractor.
    IndexersModule,
    // DomainPackInstallService invalidates the MCP pack-tools reader
    // cache on install/uninstall (PackToolsReaderService export).
    McpModule,
  ],
  controllers: [
    AdminController,
    AdminDemoController,
    AdminEvalController,
    AdminPredicatesController,
    AdminJobsController,
    AdminOpsController,
    AdminInfraController,
    AdminPacksController,
    AdminPoliciesController,
    AdminPolicyController,
    AdminPolicyDecisionsController,
    AdminKeysController,
    AdminCodeMemoryController,
    AdminHnswController,
    AdminEmbeddingSpaceController,
    AdminAggregatesController,
    AdminDeriveController,
    AdminSegmentsController,
    AdminScenesController,
    ProjectionsController,
  ],
  providers: [
    AdminService,
    HnswMaintenanceService,
    AggregateComposerService,
    ArcComposerService,
    WindowDeriverService,
    SegmentComposerService,
    SegmentBackfillService,
    SceneComposerService,
    SceneEnricherService,
    SceneBacklinkService,
    BeliefPromotionService,
    SceneVersionService,
    AdminInfraService,
    HealthComponentsService,
    LiveSnapshotService,
    DemoStateService,
    DemoPipelineService,
    DemoChatService,
    DomainPackInstallService,
    // MemoryModelReaderService moved to AiModule (@Global, exported) in
    // 0110: the documents pipeline consumes it too, and two per-module
    // instances would split the cache the install path invalidates.
    PackEvalService,
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
    // Chat-router stage services (max-params split):
    ChatRouterLlmService,
    ChatRoutePlannerService,
    PredicatePlanService,
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
